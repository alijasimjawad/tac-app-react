import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import styles from './Topbar.module.css';

interface TopbarProps {
  title: string;
  onMenuOpen: () => void;
}

const HamburgerIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
);

export default function Topbar({ title, onMenuOpen }: TopbarProps) {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

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
      <span className={styles.title}>{title}</span>
      <div className={styles.right}>
        <div className={styles.avatar}>{initials}</div>
        <div className={styles.userInfo}>
          <div className={styles.userName}>{currentUser?.full_name || currentUser?.username}</div>
          <div className={styles.userRole}>{currentUser?.role}</div>
        </div>
        <button className={styles.logoutBtn} onClick={handleLogout} title="Sign out">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </button>
      </div>
    </header>
  );
}
