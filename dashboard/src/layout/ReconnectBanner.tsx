import { useSyncExternalStore } from 'react';
import { getSocketStatus, onSocketStatus } from '../realtime/socket';
import styles from './ReconnectBanner.module.css';

export function ReconnectBanner() {
  const status = useSyncExternalStore(onSocketStatus, getSocketStatus, getSocketStatus);
  if (status === 'connected') return null;
  return (
    <div className={styles.banner} role="alert">
      {status === 'connecting' ? 'Reconnecting…' : 'Connection lost — retrying…'}
    </div>
  );
}
