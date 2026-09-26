import type { Config } from "./config.js";

export interface Mailer {
  sendMagicLink(to: string, url: string): Promise<void>;
  sendRecordIssued(to: string, recordUrl: string): Promise<void>;
  sendViewerInvite(to: string, agentName: string, loginUrl: string): Promise<void>;
}

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Agent names are owner-set free text (up to 100 chars, no HTML restrictions at the
 * schema level) and end up interpolated into HTML email bodies — escape before use. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain inline-styled HTML — email clients strip <style> blocks and web fonts
 * unreliably, so this deliberately doesn't reach for the site's own design system. */
function renderEmail(opts: { preheader: string; heading: string; intro: string; ctaText: string; ctaUrl: string; note: string }): string {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#F6F8F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${opts.preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #E3E7E4;border-radius:12px;padding:32px;max-width:480px;">
          <tr><td style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#0F6E56;font-weight:600;padding-bottom:20px;">OpenGlass</td></tr>
          <tr><td style="font-size:20px;font-weight:600;color:#12181B;padding-bottom:12px;">${opts.heading}</td></tr>
          <tr><td style="font-size:14px;line-height:1.6;color:#4A524E;padding-bottom:24px;">${opts.intro}</td></tr>
          <tr><td style="padding-bottom:28px;">
            <a href="${opts.ctaUrl}" style="display:inline-block;background:#12181B;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">${opts.ctaText}</a>
          </td></tr>
          <tr><td style="font-size:12px;line-height:1.6;color:#8A928D;border-top:1px solid #E3E7E4;padding-top:16px;">${opts.note}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function magicLinkEmail(url: string): EmailContent {
  return {
    subject: "Sign in to OpenGlass",
    text: `Sign in to OpenGlass\n\n${url}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request it, you can safely ignore this email.`,
    html: renderEmail({
      preheader: "Your OpenGlass sign-in link",
      heading: "Sign in to OpenGlass",
      intro: "Use the button below to sign in. This link expires in 15 minutes and can only be used once.",
      ctaText: "Sign in",
      ctaUrl: url,
      note: "If you didn't request this, you can safely ignore this email — no changes will be made to any account.",
    }),
  };
}

function viewerInviteEmail(agentName: string, loginUrl: string): EmailContent {
  const safeName = escapeHtml(agentName);
  return {
    subject: `You've been given viewer access to ${agentName}`,
    text: `You've been given read-only viewer access to ${agentName}'s witnessed sessions and records on OpenGlass.\n\nSign in to view them: ${loginUrl}\n\nYou can see the same records its owner can, but you can't act as the agent or change anything.`,
    html: renderEmail({
      preheader: `Viewer access to ${safeName} on OpenGlass`,
      heading: "You've been given viewer access",
      intro: `You&#39;ve been given read-only access to <strong>${safeName}</strong>&#39;s witnessed sessions and records on OpenGlass — the same signed, verifiable records its owner sees. You can&#39;t act as the agent or change anything.`,
      ctaText: "Sign in to view",
      ctaUrl: loginUrl,
      note: "If you weren't expecting this, you can ignore this email — no account changes have been made.",
    }),
  };
}

function recordIssuedEmail(recordUrl: string): EmailContent {
  return {
    subject: "A session record was issued",
    text: `A session record was issued.\n\nView and verify it: ${recordUrl}\n\nThe record is independently verifiable — you don't need to trust OpenGlass's word for it.`,
    html: renderEmail({
      preheader: "A witnessed session record is ready to verify",
      heading: "A session record was issued",
      intro:
        "One of your agents just completed a witnessed session on OpenGlass. The signed, hash-chained record is ready — you can view it and verify every signature independently, without trusting OpenGlass's word for it.",
      ctaText: "View record",
      ctaUrl: recordUrl,
      note: "You're receiving this because you own an agent that participated in this session.",
    }),
  };
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
export function createCapturingMailer(): Mailer & {
  sent: { kind: "magic_link" | "record_issued" | "viewer_invite"; to: string; url: string; agentName?: string }[];
} {
  const sent: { kind: "magic_link" | "record_issued" | "viewer_invite"; to: string; url: string; agentName?: string }[] = [];
  return {
    sent,
    async sendMagicLink(to, url) {
      sent.push({ kind: "magic_link", to, url });
    },
    async sendRecordIssued(to, url) {
      sent.push({ kind: "record_issued", to, url });
    },
    async sendViewerInvite(to, agentName, url) {
      sent.push({ kind: "viewer_invite", to, url, agentName });
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
      const { subject, text, html } = magicLinkEmail(url);
      await t.sendMail({ from: opts.from, to, subject, text, html });
    },
    async sendRecordIssued(to, recordUrl) {
      const t = await getTransport();
      const { subject, text, html } = recordIssuedEmail(recordUrl);
      await t.sendMail({ from: opts.from, to, subject, text, html });
    },
    async sendViewerInvite(to, agentName, loginUrl) {
      const t = await getTransport();
      const { subject, text, html } = viewerInviteEmail(agentName, loginUrl);
      await t.sendMail({ from: opts.from, to, subject, text, html });
    },
  };
}

function createSesMailer(opts: { from: string; region?: string }): Mailer {
  const send = async (to: string, content: EmailContent) => {
    const { SendEmailCommand, SESv2Client } = await import("@aws-sdk/client-sesv2");
    const client = new SESv2Client({ region: opts.region });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: opts.from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: { Subject: { Data: content.subject }, Body: { Text: { Data: content.text }, Html: { Data: content.html } } },
        },
      }),
    );
  };
  return {
    sendMagicLink: (to, url) => send(to, magicLinkEmail(url)),
    sendRecordIssued: (to, recordUrl) => send(to, recordIssuedEmail(recordUrl)),
    sendViewerInvite: (to, agentName, loginUrl) => send(to, viewerInviteEmail(agentName, loginUrl)),
  };
}
