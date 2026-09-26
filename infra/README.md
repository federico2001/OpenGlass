# Infrastructure (AWS CDK)

[`lib/openglass-stack.ts`](lib/openglass-stack.ts) defines one stack, `OpenGlass`:

| Resource | Details |
| -------- | ------- |
| ECR | `openglass-api`, `-mcp`, `-worker`, `-web`. Scan on push, keeps the last 30 images. |
| EC2 | `t4g.small` (arm64, Amazon Linux 2023) with Docker and the Compose plugin. Public subnet, Elastic IP, ports 80/443 only. No SSH: use SSM Session Manager. IMDSv2 with hop limit 2, so containers get the instance role's credentials. |
| Instance role | SSM (managed instance + `/openglass/prod/*` parameters), ECR pull, `kms:Sign`/`GetPublicKey` on the signer key, S3 put/read on the records bucket, read on the deploy bucket, SES send for the zone's identity |
| S3 | Records bucket: versioned, Object Lock with default retention (COMPLIANCE 365 days — irreversible, not even by the account root; set `OG_OBJECT_LOCK_MODE=GOVERNANCE` for a throwaway/dev stack you might need to delete), SSE-S3, TLS only, retained on stack delete. Deploy bucket: release bundles, expire after 90 days. |
| KMS | `alias/openglass-signer`: `ECC_NIST_P256`, `SIGN_VERIFY` (platform signer, SPEC D6) |
| Route 53 | `A` record `OG_DOMAIN` pointing at the Elastic IP, in an existing hosted zone |
| SES | Domain identity for the hosted zone, with Easy DKIM records |
| SSM | Non-secret config under `/openglass/prod/` (`SIGNER=kms`, `EMAIL=ses`, `S3_*`, `KMS_KEY_ID`, …) |
| GitHub OIDC | Deploy role that only `repo:<OG_GITHUB_REPO>:ref:refs/heads/main` can assume. It can push to ECR, write the deploy bucket, and `ssm:SendCommand` to the instance. |
| Budget | `openglass-monthly`, $100/month. Emails at 80% and 100% actual, and at 100% forecast. |

## First deploy

Prerequisites:
- An AWS account with credentials for an admin.
- A Route 53 public hosted zone for your domain.
- An Atlas cluster.

```sh
cd infra
export CDK_DEFAULT_ACCOUNT=123456789012 CDK_DEFAULT_REGION=us-east-1
export OG_DOMAIN=openglass.example.com OG_HOSTED_ZONE_ID=Z0123… OG_HOSTED_ZONE_NAME=example.com
export OG_BUDGET_EMAIL=you@example.com OG_ACME_EMAIL=you@example.com
# export OG_CREATE_GITHUB_OIDC_PROVIDER=false   # if the account already has token.actions.githubusercontent.com

pnpm exec cdk bootstrap             # once per account/region
pnpm exec cdk deploy                # prints the outputs used below
```

1. **Set the MongoDB URI.** CloudFormation can't create SecureStrings, so this step is manual:
   ```sh
   aws ssm put-parameter --name /openglass/prod/MONGODB_URI --type SecureString \
     --value 'mongodb+srv://openglass:<password>@<cluster>.mongodb.net/openglass?retryWrites=true&w=majority'
   ```
   In Atlas, add the stack's `PublicIp` output to the network access list. Give the `openglass` user `readWrite` and `dbAdmin` on the `openglass` database.
2. **Set GitHub repository variables** from the outputs (Settings → Secrets and variables → Actions → Variables):
   `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `EC2_INSTANCE_ID`, `DEPLOY_BUCKET` (output `DeployBucketName`), `OPENGLASS_DOMAIN`.
3. **Push to `main`**, or run the Deploy workflow by hand. The workflow runs the tests and pushes `linux/arm64` images tagged with the commit SHA. Then it runs [`deploy/deploy.sh`](../deploy/deploy.sh) on the instance through SSM Run Command. That script renders `.env` from `/openglass/prod/*`, pulls the images, runs `docker compose -f compose.prod.yml up -d --wait`, and checks `/health`. The last workflow step checks `https://$OPENGLASS_DOMAIN/health` from outside and fails unless it returns 200.
4. **SES**: new accounts are in the SES sandbox. Request production access before sending to unverified addresses.
5. **x402 premium tier (optional)**: omit `OG_X402_PAY_TO_ADDRESS` to leave `/v1/premium/*` disabled entirely. To enable it for real (Base mainnet) payments:
   ```sh
   export OG_X402_PAY_TO_ADDRESS=0x... OG_CDP_API_KEY_ID=...   # OG_X402_NETWORK defaults to eip155:8453
   pnpm exec cdk deploy
   aws ssm put-parameter --name /openglass/prod/CDP_API_KEY_SECRET --type SecureString --value '<cdp-api-key-secret>'
   ```
   The free public facilitator (used when these are unset, e.g. local dev) only settles Base Sepolia testnet — real payments need a CDP API key from [portal.cdp.coinbase.com/api-keys/secret](https://portal.cdp.coinbase.com/api-keys/secret), IP-allowlisted to the stack's `PublicIp` output.

## Checks that don't need AWS

```sh
pnpm --filter @openglass/infra test      # CDK assertion tests
pnpm --filter @openglass/infra typecheck
```

`cdk synth` looks up availability zones, so it needs AWS credentials, like `cdk deploy` does.
