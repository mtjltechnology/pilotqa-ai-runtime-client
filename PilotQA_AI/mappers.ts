import { ActionMapper } from "./types";

export const baseMapper: ActionMapper = (raw) => ({
  ...raw,
  normalizedAction: raw.action,
});

export const actionMappers: ActionMapper[] = [baseMapper];

export const registerActionMapper = (fn: ActionMapper) =>
  actionMappers.push(fn);
