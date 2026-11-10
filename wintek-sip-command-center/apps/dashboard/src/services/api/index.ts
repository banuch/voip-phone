import type { DataService } from './data-service';
import { HttpDataService } from './http-data-service';
import { MockDataService } from './mock-data-service';

/**
 * Single switch between the real API and the mock simulation.
 *   VITE_DATA_SOURCE=mock  -> MockDataService (UI development; shows a DEMO DATA banner)
 *   anything else          -> HttpDataService (default; required for production builds)
 * A production build with mock data must be opted into explicitly with
 * VITE_ALLOW_MOCK_IN_PRODUCTION=true, so demo metrics can't ship by accident.
 */
const wantMock = import.meta.env.VITE_DATA_SOURCE === 'mock';
if (wantMock && import.meta.env.PROD && import.meta.env.VITE_ALLOW_MOCK_IN_PRODUCTION !== 'true') {
  throw new Error('Refusing to start a production build with mock data (set VITE_DATA_SOURCE=api).');
}

export const dataService: DataService = wantMock ? new MockDataService() : new HttpDataService();
export const isMock = dataService.kind === 'mock';
export { ApiError } from './data-service';
export type { DataService, ConnectionState } from './data-service';
