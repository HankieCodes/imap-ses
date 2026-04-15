import { Validator } from 'sns-cloudflare-validator';

export default {
    async fetch(request, env) {
        let payload;
        try {
            const validator = new Validator();
            payload = await validator.validate(request);

            if (payload.TopicArn !== env.SNS_TOPIC_ARN) {
                throw new Error('Invalid topic ARN');
            }
        } catch (e) {
            const error = e as Error;
            console.warn(`Error processing SNS message: ${error.message}`);
            return new Response(error.message, {
                status: 400,
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
        }

        try {
            const response = await env.VPC_SERVICE.fetch("http://imap-ses:2525", {
                method: "POST",
                body: JSON.stringify(payload),
            });

            const data = await response.text();
            if (!response.ok) {
                throw new Error(data);
            }

            return new Response(data, {
                headers: {
                    "Content-Type": response.headers.get("content-type") || "text/plain",
                },
            });
        } catch (e) {
            const error = e as Error;
            console.error(`Error fetching from VPC service: ${error.message}`);
            return new Response(error.message, {
                status: 500,
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
        }
    },
} satisfies ExportedHandler<Env>;
