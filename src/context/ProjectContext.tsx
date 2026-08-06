import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ensureCapexProjectsLoaded,
  getCapexProjects,
  getDefaultCapexProject,
  addCapexProject,
  renameCapexProject,
  deleteCapexProject,
  type CapexProject,
} from '../lib/capexProjectsCache';

const STORAGE_KEY = 'tac_selected_capex_project';
const QUERY_KEY = 'project';

interface ProjectContextValue {
  projects: CapexProject[];
  loading: boolean;
  selectedProjectId: string | null;
  selectedProject: CapexProject | null;
  setSelectedProjectId: (id: string) => void;
  createProject: (name: string) => Promise<CapexProject | null>;
  renameProject: (id: string, name: string) => Promise<boolean>;
  deleteProject: (id: string) => Promise<boolean>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

// Mirrors AuthContext.tsx's context/provider/hook shape. Must be mounted
// inside <BrowserRouter> (uses useSearchParams for URL persistence).
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<CapexProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(
    () => searchParams.get(QUERY_KEY) || localStorage.getItem(STORAGE_KEY) || null,
  );

  useEffect(() => {
    ensureCapexProjectsLoaded().then(() => {
      const loaded = getCapexProjects();
      setProjects(loaded);
      setLoading(false);
      // Resolve the initial selection once real data is in: keep it if it's
      // still a valid project, otherwise fall back to whichever one is
      // flagged is_current (or the first one).
      setSelectedProjectIdState(prev => {
        if (prev && loaded.some(p => p.id === prev)) return prev;
        return getDefaultCapexProject()?.id ?? null;
      });
    });
  }, []);

  const persist = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set(QUERY_KEY, id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setSelectedProjectId = useCallback((id: string) => {
    setSelectedProjectIdState(id);
    persist(id);
  }, [persist]);

  // Keeps the URL in sync once the initial project resolves — covers the
  // case where the selection came from localStorage rather than the URL
  // on first load (e.g. a fresh visit to /dashboard with no ?project=).
  useEffect(() => {
    if (!selectedProjectId) return;
    if (searchParams.get(QUERY_KEY) === selectedProjectId) return;
    persist(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  const createProject = useCallback(async (name: string) => {
    const created = await addCapexProject(name);
    if (created) {
      setProjects(getCapexProjects());
      setSelectedProjectId(created.id);
    }
    return created;
  }, [setSelectedProjectId]);

  const renameProject = useCallback(async (id: string, name: string) => {
    const ok = await renameCapexProject(id, name);
    if (ok) setProjects(getCapexProjects());
    return ok;
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    const ok = await deleteCapexProject(id);
    if (ok) {
      const remaining = getCapexProjects();
      setProjects(remaining);
      // If the deleted project was the active selection, fall back to
      // whichever one is flagged is_current, or the first remaining one.
      if (selectedProjectId === id) {
        const next = getDefaultCapexProject()?.id ?? remaining[0]?.id ?? null;
        if (next) setSelectedProjectId(next);
      }
    }
    return ok;
  }, [selectedProjectId, setSelectedProjectId]);

  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null;

  return (
    <ProjectContext.Provider
      value={{
        projects, loading, selectedProjectId, selectedProject,
        setSelectedProjectId, createProject, renameProject, deleteProject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside ProjectProvider');
  return ctx;
}
