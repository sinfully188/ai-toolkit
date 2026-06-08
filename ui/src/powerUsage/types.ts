export interface PowerUsageSummary {
  averagePowerW: number;
  peakPowerW: number;
  totalEnergyWh: number;
  estimatedCost: number | null;
  currency: string | null;
  sampleCount: number;
  finalStatus: string | null;
}
