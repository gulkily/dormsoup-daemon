import assert from "assert";
import dotenv from "dotenv";
import HttpStatus from "http-status-codes";
import { RateLimiter } from "limiter-es6-compat";
import { Configuration, CreateChatCompletionRequest, OpenAIApi } from "openai";

dotenv.config();

export interface Event {
  title: string;
  dateTime: Date;
  location: string;
  organizer: string;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
assert(OPENAI_API_KEY !== undefined, "OPENAI_API_KEY environment variable must be set");

const openai = new OpenAIApi(
  new Configuration({
    apiKey: OPENAI_API_KEY
  })
);

type LLMRateLimiter = {
  rpmLimiter: RateLimiter;
  tpmLimiter: RateLimiter;
};

const GPT_3_LIMITER: LLMRateLimiter = {
  rpmLimiter: new RateLimiter({ tokensPerInterval: 3500, interval: "minute" }),
  tpmLimiter: new RateLimiter({ tokensPerInterval: 90000, interval: "minute" })
};

const GPT_4_LIMITER: LLMRateLimiter = {
  rpmLimiter: new RateLimiter({ tokensPerInterval: 200, interval: "minute" }),
  tpmLimiter: new RateLimiter({ tokensPerInterval: 40000, interval: "minute" })
};

const MODEL_LIMITERS: { [modelName: string]: LLMRateLimiter } = {
  "gpt-3.5-turbo-0613": GPT_3_LIMITER,
  "gpt-3.5-turbo-16k-0613": GPT_3_LIMITER,
  "gpt-4-0613": GPT_4_LIMITER
};

export function estimateTokens(text: string): number {
  const crudeEstimate = text.length / 4;
  const educatedEstimate = text.split(/\b/g).filter((word) => word.trim().length > 0).length / 0.75;
  return Math.ceil(Math.max(crudeEstimate, educatedEstimate));
}

export async function createChatCompletionWithRetry(
  request: CreateChatCompletionRequest,
  backOffTimeMs: number = 1000
): Promise<any> {
  let response;
  const limiter = MODEL_LIMITERS[request.model];
  if (limiter !== undefined) {
    const text = request.messages.map((msg) => msg.content).join("\n");
    const tokens = estimateTokens(text);
    await limiter.rpmLimiter.removeTokens(1);
    await limiter.tpmLimiter.removeTokens(tokens);
  }

  while (true) {
    response = await openai.createChatCompletion(request, {
      validateStatus: (status) => true
    });
    if (response.status === HttpStatus.OK) break;
    if (
      response.status === HttpStatus.TOO_MANY_REQUESTS ||
      response.status === HttpStatus.SERVICE_UNAVAILABLE ||
      response.status === HttpStatus.BAD_GATEWAY
    ) {
      if (process.env.DEBUG_MODE) console.warn(`Rate limited. Retrying in ${backOffTimeMs} ms...`);
      await new Promise((resolve) => setTimeout(resolve, backOffTimeMs));
      backOffTimeMs = Math.min(20000, backOffTimeMs * 1.5);
      if (backOffTimeMs > 20000 && false)
        throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    } else if (response.status === HttpStatus.BAD_REQUEST) {
      if (process.env.DEBUG_MODE) console.warn("Bad request: ", response);
    } else {
      throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    }
  }
  const completion = response.data.choices[0];
  assert(
    completion.finish_reason === "stop" || completion.finish_reason === "function_call",
    "OpenAI API call failed"
  );
  let completionArguments = completion.message?.function_call?.arguments;
  assert(completionArguments !== undefined);
  try {
    return JSON.parse(completionArguments);
  } catch (error) {
    console.log("JSON parse error from parsing ", completionArguments);
    throw error;
  }
}

export function removeBase64(input: string) {
  const startKeyword = ";base64,";
  const start = input.indexOf(";base64,");
  if (start === -1) return input;
  let end = start + startKeyword.length;
  while (end < input.length) {
    const charCode = input.charCodeAt(end);
    if (65 <= charCode && charCode <= 90) end++;
    else if (97 <= charCode && charCode <= 122) end++;
    else if (48 <= charCode && charCode <= 57) end++;
    else if (charCode === 43 || charCode === 47 || charCode === 61) end++;
    else break;
  }
  return removeBase64(input.slice(0, start) + input.slice(end));
}
