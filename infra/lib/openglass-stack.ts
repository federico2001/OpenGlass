import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_budgets as budgets, aws_ec2 as ec2, aws_ecr as ecr, aws_iam as iam, aws_kms as kms,
  aws_route53 as route53, aws_s3 as s3, aws_ses as ses, aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export const APPS = ["api", "mcp", "worker", "web"] as const;

export interface OpenGlassStackProps extends StackProps {
  /** Public hostname served by Caddy, e.g. openglass.example.com. */
  domainName: string;
  /** Existing Route 53 public hosted zone that contains domainName. */
  hostedZoneId: string;
  hostedZoneName: string;
  /** owner/repo allowed to deploy from its main branch via GitHub OIDC. */
  githubRepo: string;
  /** Receives AWS Budgets alerts. */
  budgetEmail: string;
  /** Let's Encrypt account email (certificate expiry notices). */
  acmeEmail: string;
  /** Set false if the account already has the token.actions.githubusercontent.com provider. */
  createGithubOidcProvider?: boolean;
  /** Default retention on the records bucket. GOVERNANCE can be bypassed by privileged users; COMPLIANCE can't. */
  objectLockMode?: "GOVERNANCE" | "COMPLIANCE";
  objectLockDays?: number;
  monthlyBudgetUsd?: number;
  /** SSM Parameter Store path rendered into the containers' .env on each deploy. */
  ssmPath?: string;
  /** Docker Compose plugin release installed on the instance. */
  composeVersion?: string;
  /** x402 premium tier (Prompt 12). Omit entirely to leave `/v1/premium/*` disabled — the
   * CDP API key SECRET is never handled here (CloudFormation can't create SecureStrings);
   * set `/openglass/prod/CDP_API_KEY_SECRET` with the AWS CLI, same as MONGODB_URI. */
  x402?: {
    /** EVM address (0x…) that receives payments. */
    payToAddress: string;
    /** CAIP-2 chain id. Defaults to Base mainnet (eip155:8453). */
    network?: string;
    /** CDP facilitator API key id (not secret on its own) — required for mainnet, since
     * the free public facilitator only settles testnet. */
    cdpApiKeyId?: string;
  };
}

export class OpenGlassStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenGlassStackProps) {
    super(scope, id, props);
    const ssmPath = props.ssmPath ?? "/openglass/prod";
    const lockDays = props.objectLockDays ?? 365;

    // ------------------------------------------------------------------ ECR
    const repos = APPS.map(
      (app) =>
        new ecr.Repository(this, `Repo-${app}`, {
          repositoryName: `openglass-${app}`,
          imageScanOnPush: true,
          lifecycleRules: [{ description: "keep the last 30 images", maxImageCount: 30 }],
          removalPolicy: RemovalPolicy.RETAIN,
        }),
    );

    // ------------------------------------------------------------------ S3
    const records = new s3.Bucket(this, "RecordsBucket", {
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention:
        props.objectLockMode === "COMPLIANCE"
          ? s3.ObjectLockRetention.compliance(Duration.days(lockDays))
          : s3.ObjectLockRetention.governance(Duration.days(lockDays)),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Release bundles (compose.prod.yml + Caddyfile) uploaded by CI, fetched by deploy.sh.
    const deployBucket = new s3.Bucket(this, "DeployBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ KMS platform signer (SIGNER=kms)
    const signer = new kms.Key(this, "SignerKey", {
      description: "OpenGlass platform signer (countersignatures and records)",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "alias/openglass-signer",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ Network
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const sg = new ec2.SecurityGroup(this, "WebSg", {
      vpc,
      description: "OpenGlass: HTTP/HTTPS only (no SSH; use SSM Session Manager)",
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP (ACME + redirect)");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), "HTTP/3");

    // ------------------------------------------------------------------ Instance role
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    for (const repo of repos) repo.grantPull(role);
    records.grantPut(role);
    records.grantRead(role); // GetObject for bundles, ListBucket for the /health HeadBucket check
    deployBucket.grantRead(role);
    signer.grant(role, "kms:Sign", "kms:GetPublicKey");
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: ssmPath.replace(/^\//, "") }),
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: `${ssmPath.replace(/^\//, "")}/*` }),
        ],
      }),
    );
    const sesIdentityArn = this.formatArn({ service: "ses", resource: "identity", resourceName: props.hostedZoneName });
    role.addToPolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: [sesIdentityArn] }));

    // ------------------------------------------------------------------ EC2
    const composeVersion = props.composeVersion ?? "v5.1.1";
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y docker python3",
      "systemctl enable --now docker",
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      `base=https://github.com/docker/compose/releases/download/${composeVersion}`,
      "cd /usr/local/lib/docker/cli-plugins",
      'curl -fsSLo docker-compose "$base/docker-compose-linux-aarch64"',
      'curl -fsSL "$base/docker-compose-linux-aarch64.sha256" | sed "s/\\*\\?docker-compose-linux-aarch64/docker-compose/" | sha256sum -c -',
      "chmod +x docker-compose",
      "docker compose version",
      "mkdir -p /opt/openglass/releases",
    );

    const instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType("t4g.small"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role,
      userData,
      userDataCausesReplacement: true,
      httpTokens: ec2.HttpTokens.REQUIRED,
      // 2 hops so containers on the Docker bridge can reach IMDSv2 for the instance role credentials.
      httpPutResponseHopLimit: 2,
      blockDevices: [
        { deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }) },
      ],
    });

    const eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc", instanceId: instance.instanceId });

    // ------------------------------------------------------------------ DNS + SES
    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });
    new route53.ARecord(this, "AppRecord", {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
      ttl: Duration.minutes(5),
    });
    // The MCP server's own subdomain (SPEC-adjacent Prompt 9: "its own container, routed
    // by Caddy at mcp.<domain>") — same single instance, so no new compute, just DNS.
    new route53.ARecord(this, "McpRecord", {
      zone,
      recordName: `mcp.${props.domainName}`,
      target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
      ttl: Duration.minutes(5),
    });
    // Domain identity with Easy DKIM records in the zone. New accounts start in the SES sandbox;
    // request production access separately.
    new ses.EmailIdentity(this, "EmailIdentity", { identity: ses.Identity.publicHostedZone(zone) });

    // ------------------------------------------------------------------ SSM parameters (non-secret)
    // MONGODB_URI is a SecureString, which CloudFormation can't create; set it with the AWS CLI (see infra/README.md).
    const params: Record<string, string> = {
      PUBLIC_URL: `https://${props.domainName}`,
      WEB_ORIGIN: `https://${props.domainName}`,
      OPENGLASS_DOMAIN: props.domainName,
      ACME_EMAIL: props.acmeEmail,
      AWS_REGION: this.region,
      S3_ENDPOINT: `https://s3.${this.region}.amazonaws.com`,
      S3_REGION: this.region,
      S3_BUCKET: records.bucketName,
      S3_FORCE_PATH_STYLE: "false",
      SIGNER: "kms",
      KMS_KEY_ID: signer.keyArn,
      PLATFORM_KID: "plat_prod",
      EMAIL: "ses",
      EMAIL_FROM: `OpenGlass <noreply@${props.domainName}>`,
      LOG_LEVEL: "info",
      PUBLIC_MCP_URL: `https://mcp.${props.domainName}`,
    };
    if (props.x402) {
      params.X402_PAY_TO_ADDRESS = props.x402.payToAddress;
      params.X402_NETWORK = props.x402.network ?? "eip155:8453";
      if (props.x402.cdpApiKeyId) params.CDP_API_KEY_ID = props.x402.cdpApiKeyId;
    }
    for (const [name, value] of Object.entries(params)) {
      new ssm.StringParameter(this, `Param-${name}`, { parameterName: `${ssmPath}/${name}`, stringValue: value });
    }

    // ------------------------------------------------------------------ GitHub Actions deploy role (OIDC)
    const oidcUrl = "https://token.actions.githubusercontent.com";
    const provider =
      props.createGithubOidcProvider === false
        ? iam.OidcProviderNative.fromOidcProviderArn(
            this,
            "GithubOidc",
            this.formatArn({ service: "iam", region: "", resource: "oidc-provider", resourceName: "token.actions.githubusercontent.com" }),
          )
        : new iam.OidcProviderNative(this, "GithubOidc", { url: oidcUrl, clientIds: ["sts.amazonaws.com"] });

    // GitHub's OIDC `sub` claim embeds each side's stable numeric id alongside its
    // (renameable) slug — `repo:{owner}@{ownerId}/{repo}@{repoId}:...` — to stop a
    // repo/org rename or transfer from letting a different entity inherit an old trust
    // policy written against the name alone. Matching `owner@*` / `repo@*` keeps this
    // readable and driven by `githubRepo` without hardcoding those ids.
    //
    // The claim's suffix also depends on how the job is triggered: deploy.yml's
    // `push-images` job (no `environment:`) gets `:ref:refs/heads/main`, but its `deploy`
    // job declares `environment: production` and gets `:environment:production` instead —
    // a different claim shape entirely, not just a different value — so both are listed.
    const [ghOwner, ghRepoName] = props.githubRepo.split("/");
    const deployRole = new iam.Role(this, "GithubDeployRole", {
      description: `GitHub Actions deploys from ${props.githubRepo}@main`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: {
          "token.actions.githubusercontent.com:sub": [
            `repo:${ghOwner}@*/${ghRepoName}@*:ref:refs/heads/main`,
            `repo:${ghOwner}@*/${ghRepoName}@*:environment:production`,
          ],
        },
      }),
    });
    for (const repo of repos) repo.grantPullPush(deployRole);
    deployBucket.grantPut(deployRole);
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:SendCommand"],
        resources: [
          this.formatArn({ service: "ec2", resource: "instance", resourceName: instance.instanceId }),
          this.formatArn({ service: "ssm", account: "", resource: "document", resourceName: "AWS-RunShellScript" }),
        ],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"], resources: ["*"] }),
    );

    // ------------------------------------------------------------------ Budget
    const budgetUsd = props.monthlyBudgetUsd ?? 100;
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "openglass-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: budgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        { threshold: 80, type: "ACTUAL" },
        { threshold: 100, type: "ACTUAL" },
        { threshold: 100, type: "FORECASTED" },
      ].map(({ threshold, type }) => ({
        notification: { comparisonOperator: "GREATER_THAN", notificationType: type, threshold, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: props.budgetEmail }],
      })),
    });

    // ------------------------------------------------------------------ Outputs (→ GitHub repo variables)
    new CfnOutput(this, "AwsRegion", { value: this.region });
    new CfnOutput(this, "AwsDeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "Ec2InstanceId", { value: instance.instanceId });
    new CfnOutput(this, "DeployBucketName", { value: deployBucket.bucketName });
    new CfnOutput(this, "OpenglassDomain", { value: props.domainName });
    new CfnOutput(this, "PublicIp", { value: eip.attrPublicIp });
    new CfnOutput(this, "RecordsBucketName", { value: records.bucketName });
    new CfnOutput(this, "SignerKeyArn", { value: signer.keyArn });
    new CfnOutput(this, "SsmPath", { value: ssmPath });
  }
}
