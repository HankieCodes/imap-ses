# IMAP-SES

A pseudo-IMAP server that bridges AWS SES Email Receiving and S3 storage with local IMAP clients, enabling applications like [Freescout](https://github.com/freescout-help-desk/freescout) and [Dmarcguard](https://github.com/dmarcguardhq/dmarcguard) to retrieve email content without exposing a public email system.

## Overview

IMAP-SES provides a secure, behind-the-firewall solution for email management:

- **No Public Email Service**: Relies entirely on AWS SES for inbound email handling and S3 for storage
- **IMAP Protocol Support**: Works with compatible IMAP clients
- **Simplified Architecture**: Receives emails via SNS/S3 notifications, and serves them over IMAP
- **Containerized**: Runs as a Docker container within your network

## Setup Guide

Based on:
- https://docs.aws.amazon.com/ses/latest/dg/receiving-email-setting-up.html
- https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
- https://github.com/devinstewart/sns-cloudflare-validator/blob/main/README.md

1. Add a DNS record for AWS SES Email Receiving
   ```
   @  IN  MX  10 inbound-smtp.<region>.amazonaws.com.
   ```
1. Create an S3 bucket for storing email copies
   ```shell
   $ aws s3api create-bucket --bucket <bucket-name> --region <region>
   ```
1. Deploy an HTTPS endpoint for proxying SNS requests to a private network
   - **Cloudflare Worker VPC**, based on https://developers.cloudflare.com/workers-vpc/get-started/#4-configure-your-worker
      ```shell
      $ git clone https://github.com/HankieCodes/imap-ses.git
      $ cd imap-ses/cloudflare
      $ cp wrangler.jsonc.example wrangler.jsonc
     
      #  Edit wrangler.jsonc with your values:
      #   - SNS_TOPIC_ARN
      #   - VPC_SERVICE_ID
     
      $ pnpm install
      $ pnpm run deploy
      ````
   - **AWS Lambda**, TBD (simple `fetch()` content, subscribe as Lambda instead of HTTP)
1. Create an SNS topic and subscription for email notifications
   ```shell
   $ aws sns create-topic --name imap-ses-email-received --region <region>
   $ aws sns subscribe --topic-arn imap-ses-email-received --protocol https --notification-endpoint <worker-url>
   ```
1. Configure AWS SES Email Receiving rules:
   1. Sign into AWS Console
   1. Open `SES > Email Receiving`
   1. Create a new ruleset as:
      1. Recipient conditions: `example.com` (your domain)
      1. Actions: `Deliver to Amazon S3 bucket`
      1. Choose the S3 bucket you created earlier
      1. Choose the SNS topic you created earlier
   1. Save the ruleset
   1. Make the ruleset active
      1. Go to `SES > Email Receiving` home
      1. Click `Set as active` for the new ruleset
1. Deploy IMAP-SES server
   - Ensure the container is on a shared network with [Cloudflared](https://hub.docker.com/r/cloudflare/cloudflared) container.
   - **Docker Compose**:
     ```shell
     $ git clone https://github.com/HankieCodes/imap-ses.git
     $ cd imap-ses
     $ cp docker-compose.example.yml docker-compose.yml
     
     #  Edit docker-compose.yml with your values:
     #   - AWS_REGION
     #   - AWS_ACCESS_KEY_ID
     #   - AWS_SECRET_ACCESS_KEY
     
     $ docker-compose up -d
     ```
   - **Docker CLI**:
     ```shell
     $ docker run -d \
       --name imap-ses \
       -p 143:143 \
       -p 2525:2525 \
       --network <network-name> \
       -v /local/mail/storage:/data \
       ghcr.io/hankiecodes/imap-ses:latest
     ```
1. Connect IMAP client (varies)
   ```
   HOST: imap-ses  # (or your docker container name)
   PORT: 143
   USERNAME: postmaster.example.com  # (or any email, replace @ with ".")
   PASSWORD: anything
   TLS/SSL: no
   ```

#### Environment Variables

- `DATA_DIR`: Root directory for email storage (default: `/data`)
- `SNS_PORT`: HTTP port for SNS notifications (default: `2525`)
- `IMAP_PORT`: TCP port for IMAP clients (default: `143`)

## How It Works

### Architecture

```
AWS SES (Email Receiving)
↓
S3 Bucket (Email Storage)
↓
SNS Topic (Event Notification)
↓
Cloudflare Worker VPC (Optional Proxy)
↓
IMAP-SES Server (Docker)
↓
IMAP Clients (Freescout, Dmarcguard)
```

## Packages

### IMAP Server (`./imap`)

A dockerized Node.js pseudo-IMAP server that:

- Listens on **port 143** (IMAP) for client connections
- Listens on **port 2525** (HTTP) for SNS notifications
- Maps each IMAP login username to a local directory (`/data/<username>/`)
- Accepts any password (no authentication required)
- Stores emails as `.eml` files in per-user directories
- Supports only the INBOX mailbox
- Implements core IMAP commands: `LOGIN`, `SELECT`, `LIST`, `FETCH`, `STORE`, `SEARCH`

**Key Features**:
- No password validation (operates within trusted network)
- Uses S3 SDK to download emails on-demand
- Parses email headers to route to correct user directory

### Cloudflare Worker Proxy (`./cloudflare`)

An optional security layer that:

- Validates SNS signatures before forwarding
- Proxies requests through Cloudflare Workers to your VPC-hosted IMAP server
- Prevents direct internet exposure of your IMAP service

## Email Storage

Emails are stored as `.eml` files in `/data/<username>/` directories:

```
/data/
  └── postmaster.example.com/
      ├── MessageId_receipt-001.eml
      ├── MessageId_receipt-002.eml
      └── MessageId_receipt-003.eml
  └── help.skyway.run/
      └── MessageId_unparseable.eml
```

- Username is the email address with `@` replaced by `.`
- Filenames include the SNS MessageId and original S3 key
- Files are deleted when marked as read (IMAP STORE with `\Seen`)

## IMAP Support

### Supported Commands

- `CAPABILITY`
- `NOOP`
- `LOGOUT`
- `LOGIN`
- `LIST`
- `SELECT INBOX`
- `STATUS`
- `FETCH` / `UID FETCH` (RFC822, RFC822.HEADER, RFC822.TEXT, ENVELOPE, FLAGS)
- `STORE` / `UID STORE` (delete via `\Seen` flag)
- `SEARCH` / `UID SEARCH`

### Limitations

- Only INBOX mailbox supported
- No authentication (assumes trusted network)
- No IMAP extensions (IDLE, COMPRESS, etc.)
- No support for multiple mailboxes
- No message flags beyond basic support

## Security Considerations

⚠️ **Important**: This server is designed for **behind-the-firewall deployment only**.

- No password validation
- Runs on unsecured IMAP port
- Assumes trusted network environment
- Use VPC/security group restrictions in AWS
- Consider Cloudflare Worker proxy for added security

## Development

This is a monorepo using `pnpm` workspaces.

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm --recursive run build

# Run IMAP server locally
cd imap
pnpm run build
node dist/server.js
```

## Troubleshooting

### Emails not appearing

1. Verify SNS topic is subscribed to your IMAP-SES HTTP endpoint
2. Check container logs: `docker logs <container>`
3. Confirm S3 bucket and SNS topic are properly configured in SES receipt rules
4. Verify IAM permissions for S3 access

### Connection refused

1. Check `IMAP_PORT` and `SNS_PORT` are correctly configured
2. Verify Docker port mappings: `-p 143:143 -p 2525:2525`
3. Confirm firewall rules allow traffic to your server

## Contributing

Contributions welcome!

## License

LGPL-3.0 — See [LICENSE.txt](./LICENSE.txt)
