import { Request, Response } from "express";
import { sendEmailService } from "../services/emailService";

export const sendEmail = async (req: Request, res: Response): Promise<void> => {
  const { to, subject, html } = req.body;
  if (!to || !subject ||!html) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  try {
    const email = await sendEmailService(to, subject, html);
    console.log("Email sent: " + to, subject);
    res.status(200).json({ message: "Email sent successfully" });
    return;
  } catch (error) {
    console.error("Error sending email:", error);

    res.status(500).json({ error: "Error sending email", message: error });
    return;
  }
};
