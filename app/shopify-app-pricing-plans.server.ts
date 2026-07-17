export const APP_PRICING_PLAN_KEYS = {
  free: "free",
  basic: "basic",
  pro: "pro",
  premium: "premium",
} as const;

export type AppPricingPlanKey =
  (typeof APP_PRICING_PLAN_KEYS)[keyof typeof APP_PRICING_PLAN_KEYS];

export type AppPricingPlanDefinition = {
  key: AppPricingPlanKey;
  label: string;
  defaultHandles: readonly string[];
  envVar: string;
  isRecurring: boolean;
};

type ResolvedAppPricingPlanDefinition = AppPricingPlanDefinition & {
  handles: string[];
};

const LEGACY_PLAN_HANDLES_ENV = "SHOPIFY_APP_PRICING_PLAN_HANDLES";
const LEGACY_SINGLE_PLAN_HANDLE_ENV = "SHOPIFY_APP_PRICING_PLAN_HANDLE";

const APP_PRICING_PLAN_DEFINITIONS = [
  {
    key: APP_PRICING_PLAN_KEYS.free,
    label: "Free",
    defaultHandles: ["free-plan"],
    envVar: "SHOPIFY_APP_PRICING_FREE_PLAN_HANDLES",
    isRecurring: false,
  },
  {
    key: APP_PRICING_PLAN_KEYS.basic,
    label: "Basic",
    defaultHandles: ["basic-plan", "lystr-connector-monthly"],
    envVar: "SHOPIFY_APP_PRICING_BASIC_PLAN_HANDLES",
    isRecurring: true,
  },
  {
    key: APP_PRICING_PLAN_KEYS.pro,
    label: "Pro",
    defaultHandles: ["pro-plan"],
    envVar: "SHOPIFY_APP_PRICING_PRO_PLAN_HANDLES",
    isRecurring: true,
  },
  {
    key: APP_PRICING_PLAN_KEYS.premium,
    label: "Premium",
    defaultHandles: ["premium-plan"],
    envVar: "SHOPIFY_APP_PRICING_PREMIUM_PLAN_HANDLES",
    isRecurring: true,
  },
] as const satisfies readonly AppPricingPlanDefinition[];

function normalizeHandle(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

function parseHandleList(value: string | null | undefined) {
  return Array.from(
    new Set(
      (value ?? "")
        .split(",")
        .map(normalizeHandle)
        .filter(Boolean)
    )
  );
}

function getConfiguredHandles(definition: AppPricingPlanDefinition) {
  const configuredHandles = parseHandleList(process.env[definition.envVar]);

  return configuredHandles.length > 0
    ? configuredHandles
    : definition.defaultHandles.map(normalizeHandle);
}

function getLegacyAcceptedHandles() {
  return [
    ...parseHandleList(process.env[LEGACY_SINGLE_PLAN_HANDLE_ENV]),
    ...parseHandleList(process.env[LEGACY_PLAN_HANDLES_ENV]),
  ];
}

export function getAppPricingPlanDefinitions() {
  return APP_PRICING_PLAN_DEFINITIONS.map((definition) => ({
    ...definition,
    handles: getConfiguredHandles(definition),
  })) satisfies ResolvedAppPricingPlanDefinition[];
}

export function getAppPricingPlanHandles() {
  const handles = [
    ...getAppPricingPlanDefinitions().flatMap((definition) => definition.handles),
    ...getLegacyAcceptedHandles(),
  ];

  return Array.from(new Set(handles.filter(Boolean)));
}

function inferPlanDefinitionFromHandle(planHandle: string) {
  if (planHandle.includes("premium")) {
    return getAppPricingPlanDefinition(APP_PRICING_PLAN_KEYS.premium);
  }

  if (planHandle.includes("basic")) {
    return getAppPricingPlanDefinition(APP_PRICING_PLAN_KEYS.basic);
  }

  if (planHandle.includes("pro")) {
    return getAppPricingPlanDefinition(APP_PRICING_PLAN_KEYS.pro);
  }

  if (planHandle.includes("free")) {
    return getAppPricingPlanDefinition(APP_PRICING_PLAN_KEYS.free);
  }

  return null;
}

export function getAppPricingPlanDefinition(
  planKey: AppPricingPlanKey | null | undefined
) {
  return (
    getAppPricingPlanDefinitions().find(
      (definition) => definition.key === planKey
    ) ?? null
  );
}

export function getAppPricingPlanDefinitionByHandle(
  planHandle: string | null | undefined
) {
  const normalizedPlanHandle = normalizeHandle(planHandle);

  if (!normalizedPlanHandle) {
    return null;
  }

  const configuredDefinition =
    getAppPricingPlanDefinitions().find((definition) =>
      definition.handles.includes(normalizedPlanHandle)
    ) ?? null;

  if (configuredDefinition) {
    return configuredDefinition;
  }

  return getLegacyAcceptedHandles().includes(normalizedPlanHandle)
    ? inferPlanDefinitionFromHandle(normalizedPlanHandle)
    : null;
}

export function isAcceptedAppPricingPlanHandle(
  planHandle: string | null | undefined
) {
  const normalizedPlanHandle = normalizeHandle(planHandle);

  return (
    Boolean(normalizedPlanHandle) &&
    getAppPricingPlanHandles().includes(normalizedPlanHandle)
  );
}

export function isFreeAppPricingPlanHandle(
  planHandle: string | null | undefined
) {
  return (
    getAppPricingPlanDefinitionByHandle(planHandle)?.key ===
    APP_PRICING_PLAN_KEYS.free
  );
}

export function getAppPricingPlanKeyFromHandle(
  planHandle: string | null | undefined
) {
  return getAppPricingPlanDefinitionByHandle(planHandle)?.key ?? null;
}
