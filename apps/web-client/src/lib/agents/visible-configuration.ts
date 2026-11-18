// Keep the legacy judge in API data without exposing its settings in the UI.
export function visibleConfiguration(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
        !['evaluation_profile', 'evaluation_prompt', 'expectations'].includes(key),
    ));
}
