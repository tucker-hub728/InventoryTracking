import type { Metadata } from 'next';

import { ForecastClient } from '@/components/forecast/forecast-client';

export const metadata: Metadata = {
  title: 'Forecast',
};

export default function ForecastPage() {
  return <ForecastClient />;
}
