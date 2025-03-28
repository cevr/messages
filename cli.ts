import * as fs from "fs";
import * as path from "path";
import { Effect, Schema } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";

import { isCancel, text } from "@clack/prompts";
import { z } from "zod";
import dotenv from "dotenv";
import {
  systemMessagePrompt,
  userMessagePrompt,
  systemReviewPrompt,
  userReviewPrompt,
  userRevisePrompt,
} from "./prompts";

dotenv.config();

const MessageSchema = z.object({
  filename: z.string(),
  message: z.string(),
});

type Message = z.infer<typeof MessageSchema>;

const yesRegex = /^y(es)?$/i;

const msToMinutes = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;
};

class Model extends Effect.Service<Model>()("Model", {
  effect: Effect.gen(function* (_) {
    const key = yield* Schema.Config("GEMINI_API_KEY", Schema.NonEmptyString);
    const model = createGoogleGenerativeAI({
      apiKey: key,
    })("gemini-2.5-pro-exp-03-25");

    return model;
  }),
}) {}

const program = Effect.gen(function* (_) {
  const startTime = Date.now();
  const model = yield* Model;

  const topic = yield* Effect.tryPromise({
    try: () =>
      text({
        message: "What would you like the message to be about?",
        placeholder: "e.g., The Power of Prayer",
      }),
    catch: (cause: unknown) =>
      new Error(
        `Failed to get topic: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
  });

  if (isCancel(topic)) {
    yield* Effect.dieMessage("Operation cancelled.");
    return;
  }

  yield* Effect.log("Generating message outline...");
  const generateStartTime = Date.now();

  const response = yield* Effect.tryPromise({
    try: () =>
      generateObject({
        model,
        schema: MessageSchema,
        messages: [
          {
            role: "system",
            content: systemMessagePrompt,
          },
          {
            role: "user",
            content: userMessagePrompt(topic),
          },
        ],
      }),
    catch: (cause: unknown) =>
      new Error(
        `Failed to generate message: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
  });

  const result = response as unknown as Message;
  let { filename, message } = result;

  yield* Effect.log(
    `Message outline generated in ${msToMinutes(Date.now() - generateStartTime)}`
  );

  yield* Effect.log("Checking if message needs revision...");
  const reviewStartTime = Date.now();

  const reviewResponse = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model,
        messages: [
          {
            role: "system",
            content: systemReviewPrompt,
          },
          {
            role: "user",
            content: userReviewPrompt(message),
          },
        ],
      }),
    catch: (cause: unknown) =>
      new Error(
        `Failed to review message: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
  });

  yield* Effect.log(
    `Message review completed in ${msToMinutes(Date.now() - reviewStartTime)}`
  );

  const needsRevision = yesRegex.test(reviewResponse.text.trim());

  if (needsRevision) {
    yield* Effect.log("Message needs revision. Revising...");
    const reviseStartTime = Date.now();

    const revisedMessage = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model,
          messages: [
            {
              role: "system",
              content: systemReviewPrompt,
            },
            {
              role: "user",
              content: userRevisePrompt(message),
            },
          ],
        }),
      catch: (cause: unknown) =>
        new Error(
          `Failed to revise message: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        ),
    });

    message = revisedMessage.text;
    yield* Effect.log(
      `Message revision completed in ${msToMinutes(Date.now() - reviseStartTime)}`
    );
  }

  const messagesDir = path.join(process.cwd(), "messages");
  const filePath = path.join(messagesDir, filename);

  yield* Effect.log(`Creating messages directory if it doesn't exist...`);
  yield* Effect.try({
    try: () => fs.mkdirSync(messagesDir, { recursive: true }),
    catch: (cause: unknown) =>
      new Error(
        `Failed to create messages directory: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
  });

  yield* Effect.log(`Writing message to ${filePath}...`);

  yield* Effect.try({
    try: () => fs.writeFileSync(filePath, message),
    catch: (cause: unknown) =>
      new Error(
        `Failed to write file: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
  });

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`✅ Message generated successfully! (Total time: ${totalTime})`);
});

const main = program.pipe(Effect.provide(Model.Default));

NodeRuntime.runMain(main);
