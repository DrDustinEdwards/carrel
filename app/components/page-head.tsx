// The top of a page inside the shell: where you are, the title, one line saying what the page is
// for, and the page's actions at the right. The same structure as Capsomer's own site.

import type { ReactNode } from "react";
import { Link } from "react-router";
import { Breadcrumb, type BreadcrumbItem } from "capsomer/react/breadcrumb";

export function PageHead({ crumbs, title, lead, actions }: { crumbs?: BreadcrumbItem[]; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="app-head">
      <div>
        {crumbs && crumbs.length > 0 ? (
          <Breadcrumb
            items={crumbs}
            renderLink={({ href, className, children }) => (
              <Link to={href} className={className}>
                {children}
              </Link>
            )}
          />
        ) : null}
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
      {actions ? <div className="app-actions">{actions}</div> : null}
    </header>
  );
}
