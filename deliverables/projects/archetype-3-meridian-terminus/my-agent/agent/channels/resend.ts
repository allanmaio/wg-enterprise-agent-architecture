import { createResendAdapter } from "@resend/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

const fromAddress = process.env.RESEND_FROM_ADDRESS || "alerts@example.com";

export const { bot, channel, send } = chatSdkChannel({
  userName: "Galaxus alerts",
  adapters: {
    resend: createResendAdapter({
      fromAddress,
      fromName: "Galaxus alerts",
    }),
  },
  state: createMemoryState(),
  // Email has no live edit stream; post the finished reply once.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

export default channel;
