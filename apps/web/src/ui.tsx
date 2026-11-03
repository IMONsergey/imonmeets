import {
  Children,
  Component,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { LoaderCircle, Video, X } from "lucide-react";
import type { Config, User, Workspace } from "./api";
export type Session = {
  user: User;
  workspaces: Workspace[];
  legalConsent?: import("./api").LegalConsentStatus;
};
export type PageProps = {
  workspace: Workspace;
  config: Config;
  notify: (s: string, e?: boolean) => void;
};
export const roleLabel = {
  owner: "Владелец",
  admin: "Администратор",
  member: "Участник",
};
export function go(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function Link({
  to,
  children,
  className = "",
  onClick,
  ...rest
}: {
  to: string;
  children: ReactNode;
  className?: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          go(to);
        }
      }}
    >
      {children}
    </a>
  );
}
export function Spinner() {
  return <LoaderCircle size={18} className="spin" aria-label="Загрузка" />;
}
export function Button({
  children,
  busy = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
      className={`button ${className}`}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}
export function ErrorBox({
  error,
  id,
  focus = false,
}: {
  error: string;
  id?: string;
  focus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error && focus) ref.current?.focus();
  }, [error, focus]);
  return error ? (
    <div
      role="alert"
      className="error-box"
      id={id}
      ref={ref}
      tabIndex={focus ? -1 : undefined}
    >
      {error}
    </div>
  ) : null;
}
export function Empty({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: typeof Video;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const hintId = useId();
  const labelId = useId();
  const described = (node: ReactNode): ReactNode => {
    if (
      !isValidElement<{
        children?: ReactNode;
        "aria-describedby"?: string;
        "aria-label"?: string;
        "aria-labelledby"?: string;
      }>(node)
    )
      return node;
    if (
      typeof node.type === "string" &&
      ["input", "textarea", "select"].includes(node.type)
    )
      return cloneElement(node, {
        "aria-labelledby":
          node.props["aria-labelledby"] ??
          (node.props["aria-label"] ? undefined : labelId),
        "aria-describedby":
          [node.props["aria-describedby"], hint ? hintId : undefined]
            .filter(Boolean)
            .join(" ") || undefined,
      });
    return node.props.children
      ? cloneElement(node, {
          children: Children.map(node.props.children, described),
        })
      : node;
  };
  return (
    <label className="field">
      <span id={labelId}>{label}</span>
      {Children.map(children, described)}
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const priorFocus = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const descriptionId = useId();
  useEffect(() => {
    const intro = ref.current?.querySelector<HTMLElement>(".modal-intro");
    if (intro) {
      intro.id ||= descriptionId;
      ref.current?.setAttribute("aria-describedby", intro.id);
    } else ref.current?.removeAttribute("aria-describedby");
  });
  useEffect(() => {
    const prior = priorFocus.current;
    const backdrop = ref.current?.parentElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backgrounds = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== backdrop,
    );
    const previous = backgrounds.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    backgrounds.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    (
      ref.current?.querySelector<HTMLElement>(
        "input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
      ) ?? ref.current?.querySelector<HTMLElement>("button:not(:disabled)")
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const controls = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex='0']",
          ) ?? [],
        );
        const visible = controls.filter(
          (control) => control.getClientRects().length > 0,
        );
        if (!visible.length) {
          e.preventDefault();
          ref.current?.focus();
          return;
        }
        const first = visible[0],
          last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
      previous.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      if (prior?.isConnected) prior.focus();
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="full-loader">
          <Brand />
          <h1>Не удалось отобразить страницу</h1>
          <p>Перезагрузите страницу или вернитесь на главную.</p>
          <Button onClick={() => location.reload()}>
            Перезагрузить страницу
          </Button>
          <a href="/" className="button primary">
            На главную
          </a>
        </main>
      );
    return this.props.children;
  }
}
export function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? "light" : ""}`}>
      <span className="brand-icon">
        <Video size={22} strokeWidth={2.6} />
      </span>
      <span>
        IMON<span className="brand-secondary"> Meets</span>
      </span>
    </div>
  );
}
