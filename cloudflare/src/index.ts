import { Validator } from 'sns-cloudflare-validator';

export default {
    async fetch(request, env) {
        try {
            const validator = new Validator();
            const payload = await validator.validate(request);

            if (payload.TopicArn !== env.SNS_TOPIC_ARN) {
                throw new Error('Invalid topic ARN');
            }

            const response = await env.VPC_SERVICE.fetch("http://imap-ses:2525");
            const data = await response.json();

            return new Response(JSON.stringify(data), {
                headers: {"content-type": "application/json"},
            });
        } catch (e) {
            const error = e as Error;
            return new Response(error.message, {
                status: 400,
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
        }
    },
} satisfies ExportedHandler<Env>;
