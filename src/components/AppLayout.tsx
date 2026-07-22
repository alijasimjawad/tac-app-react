import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import styles from './AppLayout.module.css';

const PAGE_TITLES: Record<string, string> = {
  '/attendance': 'My Attendance',
  '/dashboard':  'Dashboard',
};

export default function AppLayout() {
  const { pathname } = useLocation();
  const title = PAGE_TITLES[pathname] ?? 'TAC Network';

  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.main}>
        <Topbar title={title} />
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
