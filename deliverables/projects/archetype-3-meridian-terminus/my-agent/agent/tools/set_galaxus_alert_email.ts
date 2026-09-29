import { defineTool } from "eve/tools";
import { z } from "zod";

import { saveAlertEmail } from "../lib/promotion-monitor";

const email = z
  .string()
  .trim()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address");

export default defineTool({
  description:
    "Save the email address that should receive Galaxus Apple promotion alerts. Call this when the user provides their address. Does not replace RESEND_API_KEY or RESEND_FROM_ADDRESS.",
  inputSchema: z.object({
    email: email.describe("Destination inbox for promotion alerts."),
  }),
  async execute(input) {
    return saveAlertEmail(input.email);
  },
});
