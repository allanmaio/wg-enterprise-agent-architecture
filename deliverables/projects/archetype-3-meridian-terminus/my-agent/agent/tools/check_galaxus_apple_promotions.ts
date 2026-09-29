import { defineTool } from "eve/tools";
import { z } from "zod";

import { currentPromotions } from "../lib/promotion-monitor";

export default defineTool({
  description:
    "List Apple products currently on promotion at Galaxus (galaxus.com / galaxus.ch). Use refresh true when the user asks what is on promotion now. Also reports whether alert email and durable price history are configured.",
  inputSchema: z.object({
    refresh: z
      .boolean()
      .optional()
      .describe("Fetch a live Galaxus sample instead of the last saved snapshot."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum products to return."),
  }),
  async execute({ refresh, limit }) {
    return currentPromotions({ refresh: refresh ?? false, limit });
  },
});
