## BuzzKill Pest Control

Monorepo for BuzzKill Pest Control applications.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/web/` | Public-facing marketing site (React + Vite) and its Amplify Gen 2 backend (`apps/web/amplify/`) |
| `docs/` | Shared reference docs (FieldRoutes API, etc.) |
| `amplify.yml` | Amplify Hosting build spec (monorepo format; each app declares its own `appRoot`) |

Each app is self-contained with its own `package.json` and lockfile — install and run from inside the app directory:

```bash
cd apps/web
npm install
npm run dev        # local dev server
npx ampx sandbox   # personal cloud sandbox for the Amplify backend
```

The Amplify Hosting app has `AMPLIFY_MONOREPO_APP_ROOT=apps/web` set in the console so builds resolve the correct app root.

---

This repository was created from the AWS Amplify React+Vite starter template, emphasizing easy setup for authentication, API, and database capabilities.

## Overview

This template equips you with a foundational React application integrated with AWS Amplify, streamlined for scalability and performance. It is ideal for developers looking to jumpstart their project with pre-configured AWS services like Cognito, AppSync, and DynamoDB.

## Features

- **Authentication**: Setup with Amazon Cognito for secure user authentication.
- **API**: Ready-to-use GraphQL endpoint with AWS AppSync.
- **Database**: Real-time database powered by Amazon DynamoDB.

## Deploying to AWS

For detailed instructions on deploying your application, refer to the [deployment section](https://docs.amplify.aws/react/start/quickstart/#deploy-a-fullstack-app-to-aws) of our documentation.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.