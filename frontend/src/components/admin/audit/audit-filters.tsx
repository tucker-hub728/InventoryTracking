'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_SEVERITY_LABEL,
  AUDIT_SUBJECT_TABLE_LABEL,
  type ApiAuditAction,
  type ApiAuditSeverity,
  type ApiAuditSubjectTable,
} from '@/lib/api/audit';

export interface AuditFilters {
  q: string;
  subjectTable: ApiAuditSubjectTable | 'all';
  severity: ApiAuditSeverity | 'all';
  action: ApiAuditAction | 'all';
  /** ISO date (YYYY-MM-DD). Empty = no filter. */
  from: string;
  /** ISO date (YYYY-MM-DD). Empty = no filter. */
  to: string;
}

export const EMPTY_FILTERS: AuditFilters = {
  q: '',
  subjectTable: 'all',
  severity: 'all',
  action: 'all',
  from: '',
  to: '',
};

interface Props {
  value: AuditFilters;
  onChange: (next: AuditFilters) => void;
}

/**
 * Filter bar for the audit viewer. Owns its own search-box debounce
 * downstream (the page client wraps ``q`` via use-debounced-value);
 * everything else triggers an immediate fetch.
 */
export function AuditFiltersBar({ value, onChange }: Props) {
  const isDirty =
    value.q !== '' ||
    value.subjectTable !== 'all' ||
    value.severity !== 'all' ||
    value.action !== 'all' ||
    value.from !== '' ||
    value.to !== '';

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
      <div className="space-y-1.5 lg:col-span-4">
        <Label htmlFor="audit-q">Search</Label>
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
            aria-hidden
          />
          <Input
            id="audit-q"
            value={value.q}
            onChange={(e) => onChange({ ...value, q: e.target.value })}
            placeholder="event type or subject label"
            className="pl-9"
          />
        </div>
      </div>

      <div className="space-y-1.5 lg:col-span-2">
        <Label htmlFor="audit-subject">Subject</Label>
        <Select
          value={value.subjectTable}
          onValueChange={(v) =>
            onChange({ ...value, subjectTable: v as AuditFilters['subjectTable'] })
          }
        >
          <SelectTrigger id="audit-subject" className="[&>span]:min-w-0 [&>span]:truncate">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All subjects</SelectItem>
            {(
              Object.keys(AUDIT_SUBJECT_TABLE_LABEL) as ApiAuditSubjectTable[]
            ).map((t) => (
              <SelectItem key={t} value={t}>
                {AUDIT_SUBJECT_TABLE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 lg:col-span-2">
        <Label htmlFor="audit-action">Action</Label>
        <Select
          value={value.action}
          onValueChange={(v) =>
            onChange({ ...value, action: v as AuditFilters['action'] })
          }
        >
          <SelectTrigger id="audit-action" className="[&>span]:min-w-0 [&>span]:truncate">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {(Object.keys(AUDIT_ACTION_LABEL) as ApiAuditAction[]).map((a) => (
              <SelectItem key={a} value={a}>
                {AUDIT_ACTION_LABEL[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 lg:col-span-2">
        <Label htmlFor="audit-severity">Severity</Label>
        <Select
          value={value.severity}
          onValueChange={(v) =>
            onChange({ ...value, severity: v as AuditFilters['severity'] })
          }
        >
          <SelectTrigger
            id="audit-severity"
            className="[&>span]:min-w-0 [&>span]:truncate"
          >
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {(Object.keys(AUDIT_SEVERITY_LABEL) as ApiAuditSeverity[]).map((s) => (
              <SelectItem key={s} value={s}>
                {AUDIT_SEVERITY_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 lg:col-span-1">
        <Label htmlFor="audit-from">From</Label>
        <Input
          id="audit-from"
          type="date"
          value={value.from}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
      </div>

      <div className="space-y-1.5 lg:col-span-1">
        <Label htmlFor="audit-to">To</Label>
        <Input
          id="audit-to"
          type="date"
          value={value.to}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
      </div>

      {isDirty && (
        <div className="flex items-end lg:col-span-12">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            <X size={12} /> Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
