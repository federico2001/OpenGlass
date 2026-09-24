import type { Config } from "./config.js";

export interface Mailer {
  sendRecordIssued(to: string, recordUrl: string): Promise<void>;
}

export function createMailer(config: Pick<Config, "EMAIL" | "SMTP_URL" | "EMAIL_FROM">, awsRegion?: string): Mailer {
  if (config.EMAIL === "smtp") {
    if (!config.SMTP_URL) throw new Error("SMTP_URL is required when EMAIL=smtp");
    return createSmtpMailer({ url: config.SMTP_URL, from: config.EMAIL_FROM });
  }
  return createSesMailer({ from: config.EMAIL_FROM, region: awsRegion });
}

export function createCapturingMailer(): Mailer & { sent: { to: string; url: string }[] } {
  const sent: { to: string; url: string }[] = [];
  return {
    sent,
    async sendRecordIssued(to, url) {
      sent.push({ to, url });
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
    async sendRecordIssued(to, recordUrl) {
      const t = await getTransport();
      await t.sendMail({ from: opts.from, to, subject: "A session record was issued", text: `View it: ${recordUrl}` });
    },
  };
}

function createSesMailer(opts: { from: string; region?: string }): Mailer {
  return {
    async sendRecordIssued(to, recordUrl) {
      const { SendEmailCommand, SESv2Client } = await import("@aws-sdk/client-sesv2");
      const client = new SESv2Client({ region: opts.region });
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: opts.from,
          Destination: { ToAddresses: [to] },
          Content: { Simple: { Subject: { Data: "A session record was issued" }, Body: { Text: { Data: `View it: ${recordUrl}` } } } },
        }),
      );
    },
  };
}
