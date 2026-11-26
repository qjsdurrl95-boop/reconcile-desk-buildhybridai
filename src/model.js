import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, Schema } from "firebase/ai";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { parsePriority } from "./reconcile.js";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
const models = new Map();

export const canUseDevice = Object.values(firebaseConfig).every(Boolean);
export const canAllowCloud = Boolean(canUseDevice && siteKey);

function modelFor(route) {
  if (models.has(route)) return models.get(route);
  if (!canUseDevice || (route === "hybrid" && !canAllowCloud)) {
    throw new Error("The selected Firebase configuration is incomplete.");
  }

  const app = initializeApp(firebaseConfig, "reconcile-desk-" + route);
  // Attach App Check only to the route that can make cloud requests.
  if (route === "hybrid") {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: false,
    });
  }
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const schema = Schema.object({
    properties: { priority: Schema.array({ items: Schema.string() }) },
  });
  const options = {
    mode: route === "device" ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: { promptOptions: { responseConstraint: schema } },
  };
  if (route === "hybrid") {
    options.inCloudParams = {
      model: "gemini-3.5-flash-lite",
      generationConfig: {
        maxOutputTokens: 200,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    };
  }
  const model = getGenerativeModel(ai, options, { timeout: 30_000 });
  models.set(route, model);
  return model;
}

export async function prioritize(route, packet, onProgress) {
  if (route !== "device" && route !== "hybrid") throw new Error("Unknown inference mode.");
  if (route === "device" && typeof globalThis.LanguageModel?.create !== "function") {
    throw new Error("The Chrome on-device model is unavailable.");
  }
  const model = modelFor(route);
  try {
    await model.initializeDeviceModel(onProgress);
  } catch (error) {
    if (route === "device") throw error;
    // In PREFER_ON_DEVICE mode the SDK can use the cloud on unsupported devices.
  }

  const instruction = [
    "Order all listed invoice exception categories for a reviewer who needs to close the handoff today.",
    "Verify errors that could block a reliable reconciliation before items that can be followed up independently.",
    "Return a JSON object with priority, an array containing each listed category key once from most urgent to least urgent.",
    "The data contains only exception categories and the count in each.",
    JSON.stringify(packet),
  ].join("\n");
  const { response } = await model.generateContent(instruction);
  const { inferenceSource } = response;
  if (inferenceSource !== InferenceSource.ON_DEVICE &&
      !(route === "hybrid" && inferenceSource === InferenceSource.IN_CLOUD)) {
    throw new Error("The SDK did not confirm an allowed inference route.");
  }
  return { priority: parsePriority(response.text(), packet), inferenceSource };
}
