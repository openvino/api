import nodemailer from 'nodemailer'
import dotenv from 'dotenv'

dotenv.config()

// Configuración correcta con TypeScript
const transporter = nodemailer.createTransport({
    host:"127.0.0.1",
    port: 1025,
    secure: false, // true para 465, false para 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },

    tls: {
        rejectUnauthorized: false
    }
});

export const sendEmailService = async (to: string, subject: string, text: string, html: string) => {
    const email = await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text,
        html
    })
    console.log('Email sent: ' + email.messageId);
}