export type WorkspaceKey = 'main' | 'organizer' | 'taxes' | 'personal' | 'super-admin' | 'enterprise';

export interface Workspace {
  key: WorkspaceKey;
  label: string;
  href: string;
}
