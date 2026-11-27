import { createContext } from 'react';

/** Launch properties supplied by iOS and Android from the installed app. */
export interface InstalledVersion {
  versionName?: string;
  buildNumber?: string;
}

export const InstalledVersionContext = createContext<InstalledVersion>({});
