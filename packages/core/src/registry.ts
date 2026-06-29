import type { ProviderDescriptor } from "./adapter";
import type { UsageProvider } from "./model";
import { claudeDescriptor, codexDescriptor, kimiDescriptor, moonshotDescriptor } from "./providers";

const DESCRIPTORS: Record<UsageProvider, ProviderDescriptor> = {
  kimi: kimiDescriptor,
  moonshot: moonshotDescriptor,
  claude: claudeDescriptor,
  codex: codexDescriptor,
};

export const ALL_PROVIDERS = Object.keys(DESCRIPTORS) as UsageProvider[];

export function getDescriptor(p: UsageProvider): ProviderDescriptor {
  const d = DESCRIPTORS[p];
  if (!d) throw new Error(`unknown provider: ${p}`);
  return d;
}

export function listDescriptors(): ProviderDescriptor[] {
  return ALL_PROVIDERS.map((p) => DESCRIPTORS[p]);
}

export function isProvider(v: string): v is UsageProvider {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, v);
}
