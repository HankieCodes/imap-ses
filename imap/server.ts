/**
 * Pseudo-IMAP + SNS HTTP server
 *
 * IMAP (port 143):  Each login username maps to /data/<username>/. No password
 *                   check — any password is accepted. Marking a message \Seen
 *                   deletes the file — "read = consumed". Only INBOX supported.
 *
 * HTTP (port 2525): POST /sns receives AWS SNS notifications. On Notification,
 *                   downloads the S3 object, reads the "To:" header from the
 *                   EML, extracts the local-part (user portion before @), and
 *                   saves the file to /data/<user>/<messageId>_<basename>.eml.
 *                   Unknown / unparseable recipients go to /data/_unknown/.
 *
 * Environment variables:
 *   DATA_DIR         Root directory for per-user mail storage  (default: /data)
 *   AWS_REGION       AWS region for S3                         (default: us-east-1)
 *   SNS_PORT         HTTP port for SNS endpoint                (default: 2525)
 *   IMAP_PORT        TCP port for IMAP                         (default: 143)
 */

import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const SNS_PORT = parseInt(process.env.SNS_PORT ?? "2525", 10);
const IMAP_PORT = parseInt(process.env.IMAP_PORT ?? "143", 10);
const FALLBACK_USER = "_unknown";

fs.mkdirSync(DATA_DIR, { recursive: true });

const s3 = new S3Client({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// Mailstore helpers
// ---------------------------------------------------------------------------

interface Message {
    uid: number;
    filename: string;
    filepath: string;
    size: number;
}

/** Return the per-user mail directory, creating it if needed. */
function userDir(username: string): string {
    // Sanitise: strip anything that could escape the data dir
    const safe = username.replace(/[^a-zA-Z0-9._\-+]/g, "_") || FALLBACK_USER;
    const dir = path.join(DATA_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Read current .eml files from a directory and assign stable UIDs for the session. */
function loadMessages(dir: string): Message[] {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".eml")).sort();
    } catch {
        return [];
    }
    return files.map((filename, idx) => {
        const filepath = path.join(dir, filename);
        const size = fs.statSync(filepath).size;
        return {
            uid: idx + 1,
            filename,
            filepath,
            size,
        };
    });
}

// ---------------------------------------------------------------------------
// EML header helpers
// ---------------------------------------------------------------------------

function extractToUser(address: string): string | null {
    return address.replace('@', '.').trim().toLowerCase() || null;
}

// ---------------------------------------------------------------------------
// IMAP server
// ---------------------------------------------------------------------------

type ImapState = "notauthenticated" | "authenticated" | "selected" | "logout";

interface ImapSession {
    state: ImapState;
    socket: net.Socket;
    username: string;     // set on LOGIN
    mailDir: string;      // resolved per-user directory
    messages: Message[];  // snapshot on SELECT
}

function handleImap(socket: net.Socket): void {
    const session: ImapSession = {
        state: "notauthenticated",
        socket,
        username: "",
        mailDir: "",
        messages: [],
    };

    const send = (line: string) => {
        socket.write(line + "\r\n");
    };

    send("* OK IMAP4rev1 pseudo-server ready");

    let buffer = "";

    socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            if (line.trim() === "") continue;
            console.log("[IMAP ←]", line);
            processCommand(session, line, send);
        }
    });

    socket.on("close", () => console.log("[IMAP] connection closed"));
    socket.on("error", (e) => console.error("[IMAP] socket error", e.message));
}

function processCommand(
    session: ImapSession,
    raw: string,
    send: (s: string) => void
): void {
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
        send("* BAD malformed command");
        return;
    }

    const ok = (msg: string) => send(`${tag} OK ${msg}`);
    const no = (msg: string) => send(`${tag} NO ${msg}`);
    const bad = (msg: string) => send(`${tag} BAD ${msg}`);

    function cmdCapability() {
        send("* CAPABILITY IMAP4rev1 AUTH=PLAIN");
        ok("CAPABILITY completed");
    }

    function cmdNoop() {
        ok("NOOP completed");
    }

    function cmdLogout() {
        send("* BYE Logging out");
        ok("LOGOUT completed");
        session.state = "logout";
        session.socket.end();
    }

    function cmdLogin(args: string) {
        // LOGIN "user" "pass" — password is intentionally ignored
        const parts = parseArgs(args);
        if (!parts[0]) {
            bad("LOGIN requires a username");
            return;
        }
        session.username = parts[0].toLowerCase();
        session.mailDir = userDir(session.username);
        session.state = "authenticated";
        console.log(`[IMAP] LOGIN user=${session.username} dir=${session.mailDir}`);
        ok("LOGIN completed");
    }

    function cmdList() {
        if (session.state === "notauthenticated") {
            no("Not authenticated");
            return;
        }
        send('* LIST (\\HasNoChildren) "/" "INBOX"');
        ok("LIST completed");
    }

    function cmdSelect(args: string) {
        if (session.state === "notauthenticated") {
            no("Not authenticated");
            return;
        }
        const mailbox = args.replace(/"/g, "").trim().toUpperCase();
        if (mailbox !== "INBOX") {
            no(`Mailbox "${mailbox}" does not exist`);
            return;
        }
        session.messages = loadMessages(session.mailDir);
        const count = session.messages.length;
        send(`* ${count} EXISTS`);
        send("* 0 RECENT");
        send("* OK [UNSEEN 1] Message 1 is first unseen");
        send("* OK [UIDVALIDITY 1] UIDs valid");
        send(`* OK [UIDNEXT ${count + 1}] Predicted next UID`);
        send(`* FLAGS (\\Seen)`);
        send("* [READ-WRITE] SELECT completed");
        session.state = "selected";
        ok(`SELECT completed`);
    }

    function cmdStatus() {
        if (session.state === "notauthenticated") {
            no("Not authenticated");
            return;
        }
        const msgs = loadMessages(session.mailDir);
        const count = msgs.length;
        send(`* STATUS INBOX (MESSAGES ${count} UNSEEN ${count} UIDNEXT ${count + 1})`);
        ok("STATUS completed");
    }

    function cmdFetch(args: string, command: string) {
        if (session.state !== "selected") {
            no("No mailbox selected");
            return;
        }

        const [seqSet, ...itemParts] = args.split(" ");
        const itemSpec = itemParts.join(" ").replace(/[()]/g, "").toUpperCase();
        const indices = resolveSequenceSet(seqSet, session.messages.length);

        for (const idx of indices) {
            const msg = session.messages[idx];
            if (!msg) continue;

            let eml = "";
            try {
                eml = fs.readFileSync(msg.filepath, "utf8");
            } catch {
                continue;
            }

            const seqNum = idx + 1;
            let [headers, ...bodies] = eml.split("\r\n\r\n");
            headers += "\r\n\r\n";
            const body = bodies.join("\r\n\r\n");

            if (itemSpec === "FLAGS") {
                send(`* ${seqNum} FETCH (UID ${msg.uid} FLAGS ())`);
            } else if (itemSpec === "RFC822.HEADER") {
                send(`* ${seqNum} FETCH (UID ${msg.uid} RFC822.HEADER {${headers.length}}`);
                send(headers + ")");
            } else if (itemSpec === "RFC822.TEXT") {
                send(`* ${seqNum} FETCH (UID ${msg.uid} RFC822.TEXT {${body.length}}`);
                send(body + ")");
            } else if (itemSpec === "RFC822") {
                send(`* ${seqNum} FETCH (UID ${msg.uid} RFC822 {${eml.length}}`);
                send(eml + ")");
            } else {
                bad(`FETCH spec ${itemSpec} not supported`);
                return;
            }
        }
        ok(`FETCH completed`);
    }

    function cmdStore(args: string) {
        if (session.state !== "selected") {
            no("No mailbox selected");
            return;
        }

        const parts = args.split(" ");
        if (parts.length < 3) {
            bad("STORE requires seq-set, item, and value");
            return;
        }

        const [seqSet, flagItem] = parts;
        const op = flagItem.toUpperCase();
        const indices = resolveSequenceSet(seqSet, session.messages.length);

        for (const idx of indices) {
            const msg = session.messages[idx];
            if (!msg) continue;

            if (fs.existsSync(msg.filepath)) {
                fs.unlinkSync(msg.filepath);
                console.log(`[IMAP] deleted (\\Seen): ${msg.filepath}`);
            }

            if (!op.includes("SILENT")) {
                send(`* ${idx + 1} FETCH (UID ${msg.uid} FLAGS ())`);
            }
        }
        ok("STORE completed");
    }

    function cmdSearch(args: string, command: string) {
        if (session.state !== "selected") {
            no("No mailbox selected");
            return;
        }
        const all = session.messages.map((_, i) => i + 1).join(" ");
        send(`* SEARCH ${all}`);
        ok(`SEARCH completed`);
    }

    const commands: {[name: string]: (args: string, command: string) => void} = {
        "CAPABILITY": cmdCapability,
        "NOOP": cmdNoop,
        "LOGOUT": cmdLogout,
        "LOGIN": cmdLogin,
        "LIST": cmdList,
        "SELECT": cmdSelect,
        "STATUS": cmdStatus,
        "FETCH": cmdFetch,
        "UID FETCH": cmdFetch,
        "STORE": cmdStore,
        "UID STORE": cmdStore,
        "SEARCH": cmdSearch,
        "UID SEARCH": cmdSearch,
    }

    const tag = raw.slice(0, spaceIdx);
    const rest = raw.slice(spaceIdx + 1);

    for (const [name, action] of Object.entries(commands)) {
        if (rest.startsWith(name)) {
            const args = rest.slice(name.length).trim();
            action(args, name);
            return;
        }
    }


    bad(`Command not implemented`);
}

// ---------------------------------------------------------------------------
// IMAP protocol utilities
// ---------------------------------------------------------------------------

function resolveSequenceSet(seqSet: string, total: number): number[] {
    const indices: number[] = [];
    for (const part of seqSet.split(",")) {
        if (part.includes(":")) {
            const [rawFrom, rawTo] = part.split(":");
            const from = parseInt(rawFrom, 10);
            const to = rawTo === "*" ? total : parseInt(rawTo, 10);
            for (let i = from; i <= to; i++) indices.push(i - 1);
        } else {
            const n = part === "*" ? total : parseInt(part, 10);
            indices.push(n - 1);
        }
    }
    return indices.filter((i) => i >= 0 && i < total);
}

function parseArgs(raw: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuote = false;
    for (const ch of raw) {
        if (ch === '"') {
            inQuote = !inQuote;
        } else if (ch === " " && !inQuote) {
            if (current) result.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    if (current) result.push(current);
    return result;
}

// ---------------------------------------------------------------------------
// SNS HTTP endpoint
// ---------------------------------------------------------------------------

interface SnsMessage {
    Type: string;
    MessageId: string;
    Message: string;
    SubscribeURL?: string;
}

interface S3EventMessage {
    mail: {
        destination: string[];
    }
    receipt: {
        action: {
            type: 'S3';
            bucketName: string;
            objectKey: string;
        }
    }
}

async function downloadEmlToBuffer(bucket: string, key: string): Promise<Buffer> {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3.send(cmd);
    const readable = response.Body as Readable;
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        readable.on("data", (chunk: Buffer) => chunks.push(chunk));
        readable.on("end", () => resolve(Buffer.concat(chunks)));
        readable.on("error", reject);
    });
}

function confirmSubscription(subscribeUrl: string): void {
    https
        .get(subscribeUrl, (res) => {
            console.log(`[SNS] subscription confirmed, status=${res.statusCode}`);
        })
        .on("error", (e) => console.error("[SNS] confirm error", e.message));
}

function handleSns(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
        res.writeHead(404).end("Not found");
        return;
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
        let sns: SnsMessage;
        try {
            sns = JSON.parse(raw);
        } catch {
            console.error("[SNS] invalid JSON", raw.slice(0, 200));
            res.writeHead(400).end("Bad JSON");
            return;
        }

        console.log(`[SNS] type=${sns.Type} messageId=${sns.MessageId}`);

        if (sns.Type === "SubscriptionConfirmation" && sns.SubscribeURL) {
            confirmSubscription(sns.SubscribeURL);
            res.writeHead(200).end("Confirming");
            return;
        }

        if (sns.Type === "Notification") {
            let event: S3EventMessage;
            try {
                event = JSON.parse(sns.Message);
            } catch {
                console.error("[SNS] Message is not JSON:", sns.Message.slice(0, 200));
                res.writeHead(200).end("OK (non-S3 notification ignored)");
                return;
            }

            if (event.receipt?.action?.type !== "S3") {
                console.error("[SNS] Message is not S3 SES receipt:", sns.Message.slice(0, 200));
                res.writeHead(200).end("OK (non-S3 notification ignored)");
                return;
            }

            const recipients = event.mail.destination;
            const bucket = event.receipt.action.bucketName;
            const key = event.receipt.action.objectKey;

            try {
                // Download into memory so we can inspect the To: header before writing
                const emlBuffer = await downloadEmlToBuffer(bucket, key);
                let emlText = emlBuffer.toString("utf8");

                if (emlText.includes("\r\nX-SimpleLogin-Original-From: ")) {
                    // revise FROM when forwarded by Proton Pass
                    emlText = emlText.replace(/\r\nFrom: (.*)\r\n/, '\r\n');
                    emlText = emlText.replace(/\r\nX-SimpleLogin-Original-From: (.*)\r\n/, '\r\nFrom: $1\r\n');
                }

                for (const recipient of recipients) {
                    const toUser = extractToUser(recipient) ?? FALLBACK_USER;
                    const destDir = userDir(toUser);
                    const filename = `${sns.MessageId}_${path.basename(key)}.eml`;
                    const dest = path.join(destDir, filename);

                    fs.writeFileSync(dest, emlText, 'utf-8');
                    console.log(`[SNS] saved s3://${bucket}/${key} → ${dest} (To user: ${toUser})`);
                }
            } catch (e) {
                console.error(`[SNS] failed to process ${key}:`, e);
            }

            res.writeHead(200).end("OK");
            return;
        }

        res.writeHead(200).end("OK (ignored)");
    });
}

// ---------------------------------------------------------------------------
// Start servers
// ---------------------------------------------------------------------------

const imapServer = net.createServer(handleImap);
imapServer.listen(IMAP_PORT, () =>
    console.log(`[IMAP] listening on port ${IMAP_PORT}`)
);

const httpServer = http.createServer(handleSns);
httpServer.listen(SNS_PORT, () =>
    console.log(`[SNS] listening on port ${SNS_PORT}`)
);

process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down");
    imapServer.close();
    httpServer.close();
});
