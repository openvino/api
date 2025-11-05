import nodemailer, { Transporter } from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const transportMode = (process.env.EMAIL_TRANSPORT || "smtp").toLowerCase();

const buildSmtpTransport = (): Transporter => {
  const port = Number(process.env.EMAIL_PORT || 1025);
  const secure = (process.env.EMAIL_SECURE || "false").toLowerCase() === "true";

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || "127.0.0.1",
    port,
    secure,
    auth:
      process.env.EMAIL_USER && process.env.EMAIL_PASS
        ? {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          }
        : undefined,
    tls: {
      rejectUnauthorized:
        (process.env.EMAIL_TLS_REJECT_UNAUTHORIZED || "false").toLowerCase() ===
        "true",
    },
  });
};

const buildSendmailTransport = (): Transporter =>
  nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: process.env.SENDMAIL_PATH || "/usr/sbin/sendmail",
  });

const transporter =
  transportMode === "sendmail" ? buildSendmailTransport() : buildSmtpTransport();

export const sendEmailService = async (
  to: string,
  subject: string,
  html: string
) => {
  const email = await transporter.sendMail({
    from: '"OpenVino" <redeem@openvino.org>',
    to,
    subject,
    html,
  });
  console.log("Email sent: " + email.messageId);
};
