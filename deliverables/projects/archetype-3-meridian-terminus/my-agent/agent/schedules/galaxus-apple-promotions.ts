import { defineSchedule } from "eve/schedules";

import { runPromotionCheck } from "../lib/promotion-monitor";

// Every 2 minutes. Vercel evaluates cron in UTC. Sub-daily cron requires a Vercel Pro (or higher) plan.
export default defineSchedule({
  cron: "*/2 * * * *",
  run({ waitUntil }) {
    waitUntil(
      runPromotionCheck().then((result) => {
        console.info(
          "[galaxus]",
          JSON.stringify({
            ok: result.ok,
            observed: result.observed,
            onPromotion: result.onPromotion,
            newlyEntered: result.newlyEntered.length,
            emailed: result.emailed,
            emailError: result.emailError,
            baseline: result.baseline,
            missing: result.missing,
            error: result.error,
          }),
        );
      }),
    );
  },
});
