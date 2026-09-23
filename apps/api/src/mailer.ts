import type { Config } from "./config.js";

export interface Mailer {
  sendMagicLink(to: string, url: string): Promise<void>;
  sendRecordIssued(to: string, recordUrl: string): Promise<void>;
}

/** `awsRegion` is only used for `EMAIL=ses` — passed separately (rather than added to
 * `Config`) since it's the same AWS region already configured for S3/KMS, not a
 * mail-specific setting. */
export function createMailer(config: Pick<Config, "EMAIL" | "SMTP_URL" | "EMAIL_FROM">, awsRegion?: string): Mailer {
  if (config.EMAIL === "smtp") {
    if (!config.SMTP_URL) throw new Error("SMTP_URL is required when EMAIL=smtp");
    return createSmtpMailer({ url: config.SMTP_URL, from: config.EMAIL_FROM });
  }
  return createSesMailer({ from: config.EMAIL_FROM, region: awsRegion });
}

/** Never actually sends; captures what would have been sent so tests can assert on it
 * without a real SMTP/SES round trip. */
export function createCapturingMailer(): Mailer & { sent: { kind: "magic_link" | "record_issued"; to: string; url: string }[] } {
  const sent: { kind: "magic_link" | "record_issued"; to: string; url: string }[] = [];
  return {
    sent,
    async sendMagicLink(to, url) {
      sent.push({ kind: "magic_link", to, url });
    },
    async sendRecordIssued(to, url) {
      sent.push({ kind: "record_issued", to, url });
    },
  };
}

function createSmtpMailer(opts: { url: string; from: string }): Mailer {
  let transport: import("nodemailer").Transporter | undefined;
  const getTransport = async () => {
    if (!transport) {
      const nodemailer = await import("nodemailer");
      transport = nodemailer.createTransport(opts.url);
    }
    return transport;
  };
  return {
    async sendMagicLink(to, url) {
      const t = await getTransport();
      await t.sendMail({ from: opts.from, to, subject: "Sign in to OpenGlass", text: `Sign in: ${url}` });
    },
    async sendRecordIssued(to, recordUrl) {
      const t = await getTransport();
      await t.sendMail({ from: opts.from, to, subject: "A session record was issued", text: `View it: ${recordUrl}` });
    },
  };
}

function createSesMailer(opts: { from: string; region?: string }): Mailer {
  const send = async (to: string, subject: string, text: string) => {
    const { SendEmailCommand, SESv2Client } = await import("@aws-sdk/client-sesv2");
    const client = new SESv2Client({ region: opts.region });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: opts.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    );
  };
  return {
    sendMagicLink: (to, url) => send(to, "Sign in to OpenGlass", `Sign in: ${url}`),
    sendRecordIssued: (to, recordUrl) => send(to, "A session record was issued", `View it: ${recordUrl}`),
  };
}
