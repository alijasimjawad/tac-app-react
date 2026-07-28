import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import styles from './Topbar.module.css';

interface TopbarProps {
  title: string;
  subtitle?: string;
  onMenuOpen: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const HamburgerIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
);

const RefreshIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export default function Topbar({ title, subtitle, onMenuOpen, onRefresh, refreshing }: TopbarProps) {
  const { currentUser } = useAuth();

  const initials = (currentUser?.full_name || currentUser?.username || 'U')
    .split(' ')
    .map(w => w[0] || '')
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <header className={styles.topbar}>
      <button className={styles.menuBtn} onClick={onMenuOpen} aria-label="Open navigation menu">
        <HamburgerIcon />
      </button>
      <div className={styles.titleGroup}>
        <span className={styles.title}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </div>
      <div className={styles.right}>
        <button
          className={`${styles.refreshBtn} ${refreshing ? styles.refreshBtnSpinning : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh page"
          title="Refresh"
        >
          <RefreshIcon />
        </button>
        <NotificationBell />
        <button className={styles.userMenu} aria-label="User menu" title="User menu">
          <div className={styles.avatar}>
            {currentUser?.profile_photo_url
              ? <img src={currentUser.profile_photo_url} alt="" className={styles.avatarImg} />
              : initials}
          </div>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{currentUser?.full_name || currentUser?.username}</div>
            <div className={styles.userRole}>{currentUser?.role}</div>
          </div>
          <ChevronDownIcon />
        </button>
      </div>
    </header>
  );
}
