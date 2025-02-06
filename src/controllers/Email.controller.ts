
import { Request, Response } from "express";
import { sendEmailService } from "../services/emailService";



export const sendEmail = async (req: Request, res: Response): Promise<void> => {
    const { to, subject, text, html } = req.body;
    try {
        const email = sendEmailService(to, subject, text, html);

        console.log('Email sent: ' + email);

    } catch (error) {
        console.error("Error sending email:", error);
    }
}