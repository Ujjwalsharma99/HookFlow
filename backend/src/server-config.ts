export function getApiPort(): number {
  return Number(process.env.PORT) || 3000;
}
