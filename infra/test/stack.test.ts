import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OpenGlassStack, type OpenGlassStackProps } from "../lib/openglass-stack.js";

const props: OpenGlassStackProps = {
  env: { account: "123456789012", region: "us-east-1" },
  domainName: "openglass.example.com",
  hostedZoneId: "Z0123456789ABCDEFGHIJ",
  hostedZoneName: "example.com",
  githubRepo: "federico2001/OpenGlass",
  budgetEmail: "ops@example.com",
  acmeEmail: "ops@example.com",
};
const synth = (overrides: Partial<OpenGlassStackProps> = {}) =>
  Template.fromStack(new OpenGlassStack(new App(), "OpenGlass", { ...props, ...overrides }));

describe("OpenGlassStack", () => {
  const t = synth();

  it("creates one ECR repo per image", () => {
    for (const app of ["api", "mcp", "worker", "web"]) {
      t.hasResourceProperties("AWS::ECR::Repository", { RepositoryName: `openglass-${app}` });
    }
  });

  it("runs a t4g.small (arm64) with IMDSv2 reachable from containers and no SSH", () => {
    t.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "t4g.small",
      ImageId: { Ref: Match.stringLikeRegexp("al2023amikernel.*arm64") },
      MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2 },
    });
    const sg = Object.values(t.findResources("AWS::EC2::SecurityGroup"))[0] as { Properties: { SecurityGroupIngress: { FromPort: number }[] } };
    expect(sg.Properties.SecurityGroupIngress.map((r) => r.FromPort).sort()).toEqual([443, 443, 80]);
  });

  it("uses an ECC_NIST_P256 SIGN_VERIFY KMS key", () => {
    t.hasResourceProperties("AWS::KMS::Key", { KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" });
  });

  it("enables Object Lock with default retention on the records bucket", () => {
    t.hasResourceProperties("AWS::S3::Bucket", {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 365 } } },
      VersioningConfiguration: { Status: "Enabled" },
    });
    synth({ objectLockMode: "COMPLIANCE", objectLockDays: 30 }).hasResourceProperties("AWS::S3::Bucket", {
      ObjectLockConfiguration: { Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 30 } } },
    });
  });

  it("gives the instance role SSM, ECR pull, KMS sign, S3 write and SES send", () => {
    const policies = JSON.stringify(t.findResources("AWS::IAM::Policy"));
    for (const action of ["ecr:BatchGetImage", "kms:Sign", "s3:PutObject", "ses:SendEmail", "ssm:GetParametersByPath"]) {
      expect(policies).toContain(action);
    }
    t.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: Match.arrayWith([Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([":iam::aws:policy/AmazonSSMManagedInstanceCore"])]) })]),
    });
  });

  it("points the domain at the Elastic IP", () => {
    t.hasResourceProperties("AWS::Route53::RecordSet", { Name: "openglass.example.com.", Type: "A", HostedZoneId: props.hostedZoneId });
  });

  it("points mcp.<domain> at the same Elastic IP", () => {
    t.hasResourceProperties("AWS::Route53::RecordSet", { Name: "mcp.openglass.example.com.", Type: "A", HostedZoneId: props.hostedZoneId });
  });

  it("alerts on a $100/month budget", () => {
    t.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetLimit: { Amount: 100, Unit: "USD" }, TimeUnit: "MONTHLY", BudgetType: "COST" },
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Subscribers: [{ SubscriptionType: "EMAIL", Address: "ops@example.com" }] }),
      ]),
    });
  });

  it("lets only main of the repo assume the deploy role", () => {
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
              StringLike: { "token.actions.githubusercontent.com:sub": "repo:federico2001@*/OpenGlass@*:ref:refs/heads/main" },
            },
          }),
        ],
      },
    });
  });

  it("can reuse an existing GitHub OIDC provider", () => {
    synth({ createGithubOidcProvider: false }).resourceCountIs("AWS::IAM::OIDCProvider", 0);
    t.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  });

  it("publishes non-secret config to SSM (MONGODB_URI is set out of band)", () => {
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: "/openglass/prod/SIGNER", Value: "kms" });
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: "/openglass/prod/EMAIL", Value: "ses" });
    const names = Object.values(t.findResources("AWS::SSM::Parameter")).map((r) => (r as { Properties: { Name: string } }).Properties.Name);
    expect(names).not.toContain("/openglass/prod/MONGODB_URI");
  });

  it("creates no Lambda-backed custom resources", () => {
    t.resourceCountIs("AWS::Lambda::Function", 0);
  });
});
