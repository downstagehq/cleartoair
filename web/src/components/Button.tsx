import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Keycap } from './Keycap';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  icon?: ReactNode;
  keycap?: string;
  block?: boolean;
  confirming?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, keycap, block, confirming, className = '', children, type = 'button', ...rest },
  ref,
) {
  const cls = [
    'btn',
    variant === 'primary' && 'btn-primary',
    variant === 'danger' && 'btn-danger',
    variant === 'ghost' && 'btn-ghost',
    size === 'sm' && 'btn-sm',
    !children && icon && 'btn-icon',
    confirming && 'is-confirming',
    block && 'w-full',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {icon}
      {children}
      {keycap ? <Keycap className="ml-1">{keycap}</Keycap> : null}
    </button>
  );
});
