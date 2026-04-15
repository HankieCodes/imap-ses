# IMAP-SES

Pseudo-IMAP server connected to AWS SES Email Receiving API and Cloudflare Worker proxy.

> **Note:** More detailed guide coming soon.

## Setup

1. Configure SES Email Receiving rules: https://docs.aws.amazon.com/ses/latest/DeveloperGuide/receiving-email-setting-up-event-notification-rules.html
   1. Write to S3 bucket
      1. With SNS Topic Subscription
   1. SNS sends to HTTPS endpoint
1. Confirm DNS MX records for SES
1. Test by sending an email

## Packages

### ./imap

This package contains a docker server, running inside your environment, which
contains a pseudo-IMAP server and SNS listener.

### ./cloudflare

Provides a Cloudflare Worker proxy.
