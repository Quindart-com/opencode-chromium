import { installClient,type ClientInstallOptions } from "./install.ts";

export function configureClient(options: ClientInstallOptions) {
  return installClient(options);
}
