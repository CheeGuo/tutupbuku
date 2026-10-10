# AWS ECS Fargate deployment

The repository includes a container image definition; this guide prepares a deployment but does not create AWS resources. Expect AWS charges for ECR storage, Fargate tasks, load balancing, logs, data transfer, and any hosted AI or OCR-adjacent services you choose.

## Required services

- ECS Fargate service in private subnets, with an Application Load Balancer in public subnets and HTTPS termination using an ACM certificate.
- ECR repository for the image and CloudWatch Logs with an explicit retention period.
- Supabase project for Postgres and the private `documents` bucket. The migration contains business membership, row policies, worker leases, proposal persistence, corrections, and approvals.
- AWS Secrets Manager entries for `SUPABASE_SERVICE_ROLE_KEY`, and (if required) `AI_API_KEY`. Do not place these values in the Docker image, task definition text, source control, or frontend.

## Build and publish

From the repository root, build the image and push it to ECR using the account, region, repository URI, and tag chosen by your AWS administrator:

```powershell
docker build -t tutupbuku:latest .
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
docker tag tutupbuku:latest <account-id>.dkr.ecr.<region>.amazonaws.com/<repository>:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/<repository>:latest
```

Create an ECS task definition with Node's port `3000`, CPU/memory sized for OCR, a task role that can read only the named Secrets Manager secrets, and log routing to CloudWatch. Set `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, `SUPABASE_URL`, `AI_BASE_URL`, `AI_MODEL`, and `MAX_PARALLEL_JOBS` as task environment settings; inject Supabase keys and `AI_API_KEY` through `secrets`. Use `/api/health` as the ALB health-check path and configure HTTPS, request timeouts, and upload limits at the ALB/WAF layer.

Run the service with at least one task and test direct page access, shared demo upload, progress, issue resolution, approval, and CSV export with non-production data before routing real documents. Keep Fargate tasks stateless: persistent files are stored in the private Supabase bucket, and the database owns job recovery/leases. Scale task count only after checking OCR memory, provider rate limits, `MAX_PARALLEL_JOBS`, and database connection/API capacity.

## Before accepting real data

1. Apply and review the Supabase migration in a non-production project. Check workspace scoping and private storage access; no Supabase Auth user is required by the demo.
2. Create secrets and a least-privilege ECS task role. Do not use AWS root credentials.
3. Register a task definition and ECS service behind HTTPS. Keep application tasks out of public subnets.
4. Configure CloudWatch retention, alarms, log access, backup/restore, and incident handling. Avoid logging receipt contents, tokens, or provider responses.
5. Use a documented AI API endpoint only if authorized. WorkBuddy desktop credits are not wired to an API by this application; local compatible model endpoints are a development option, not an AWS production service.

No resources are created by this repository or these instructions. Validate the deployment in your AWS account before use.
