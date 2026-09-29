import { defineSchedule } from "eve/schedules";

import { runPromotionCheck } from "../lib/promotion-monitor";

// 06:00 UTC daily. Vercel evaluates cron in UTC. Once a day stays within Hobby cron limits.
export default defineSchedule({
  cron: "0 6 * * *",
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
