'use client';

import Link from 'next/link';
import { Show, SignInButton, UserButton } from '@clerk/nextjs';
import styles from './Header.module.css';

export default function Header() {
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>
        BMS
      </Link>
      <nav className={styles.nav}>
        <Show when="signed-in">
          <Link href="/bookings">My bookings</Link>
          <UserButton />
        </Show>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button type="button" className={styles.signIn}>
              Sign in
            </button>
          </SignInButton>
        </Show>
      </nav>
    </header>
  );
}
