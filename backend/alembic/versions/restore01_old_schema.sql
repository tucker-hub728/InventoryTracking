--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: meta; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA meta;


--
-- Name: invite_status; Type: TYPE; Schema: app; Owner: -
--

CREATE TYPE app.invite_status AS ENUM (
    'pending',
    'accepted',
    'revoked',
    'expired'
);


--
-- Name: tg_movements_immutable(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.tg_movements_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION
                'app.stock_movements is append-only; reverse via counter-movement instead'
                USING ERRCODE = '23000';  -- integrity_constraint_violation
            RETURN NULL;  -- never reached, keeps the planner happy
        END;
        $$;


--
-- Name: tg_touch_updated_at(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.tg_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END;
        $$;


--
-- Name: tg_audit_events_immutable(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE FUNCTION audit.tg_audit_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION
                'audit.audit_events is append-only; UPDATE/DELETE forbidden';
        END;
        $$;


--
-- Name: tg_reauth_consumptions_immutable(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE FUNCTION audit.tg_reauth_consumptions_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION
                'audit.reauth_consumptions is append-only; rows cannot be modified or removed'
                USING ERRCODE = '23000';
            RETURN NULL;
        END;
        $$;


--
-- Name: tg_reauth_events_immutable(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE FUNCTION audit.tg_reauth_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION
                'audit.reauth_events is append-only; rows cannot be modified or removed'
                USING ERRCODE = '23000';  -- integrity_constraint_violation
            RETURN NULL;
        END;
        $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bom_lines; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.bom_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_item_id uuid NOT NULL,
    child_item_id uuid NOT NULL,
    qty_per_run numeric(14,3) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by_user_id uuid NOT NULL,
    updated_by_user_id uuid NOT NULL,
    CONSTRAINT ck_bom_lines_ck_bom_lines_no_self_reference CHECK ((parent_item_id <> child_item_id)),
    CONSTRAINT ck_bom_lines_ck_bom_lines_qty_per_run_positive CHECK ((qty_per_run > (0)::numeric))
);


--
-- Name: customer_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.customer_items (
    customer_id uuid NOT NULL,
    item_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid NOT NULL
);


--
-- Name: customers; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    contact_person text,
    email public.citext,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by_user_id uuid NOT NULL,
    updated_by_user_id uuid NOT NULL,
    CONSTRAINT ck_customers_ck_customers_name_not_blank CHECK ((char_length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: forecast_entries; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.forecast_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    customer_id uuid,
    forecast_year integer NOT NULL,
    forecast_month integer NOT NULL,
    runs integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid NOT NULL,
    updated_by_user_id uuid NOT NULL,
    CONSTRAINT ck_forecast_entries_ck_forecast_entries_month_range CHECK (((forecast_month >= 1) AND (forecast_month <= 12))),
    CONSTRAINT ck_forecast_entries_ck_forecast_entries_runs_positive CHECK ((runs > 0)),
    CONSTRAINT ck_forecast_entries_ck_forecast_entries_year_range CHECK (((forecast_year >= 2000) AND (forecast_year <= 2100)))
);


--
-- Name: invitations; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    role text NOT NULL,
    cognito_sub text,
    token_hash text NOT NULL,
    status app.invite_status DEFAULT 'pending'::app.invite_status NOT NULL,
    invited_by uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: item_categories; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.item_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    tone text DEFAULT 'neutral'::text NOT NULL,
    is_seeded boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT ck_item_categories_ck_item_categories_kind CHECK ((kind = ANY (ARRAY['purchased'::text, 'built'::text]))),
    CONSTRAINT ck_item_categories_ck_item_categories_name_not_blank CHECK ((char_length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_number text NOT NULL,
    description text NOT NULL,
    avg_lead_days integer,
    reorder_threshold numeric(14,3) DEFAULT 0 NOT NULL,
    must_order_flag boolean DEFAULT false NOT NULL,
    last_updated_on date,
    row_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by_user_id uuid NOT NULL,
    updated_by_user_id uuid NOT NULL,
    near_expiry_threshold_days integer DEFAULT 30 NOT NULL,
    category_id uuid NOT NULL,
    CONSTRAINT ck_items_ck_items_near_expiry_threshold_days_nonneg CHECK ((near_expiry_threshold_days >= 0)),
    CONSTRAINT ck_items_ck_items_reorder_threshold_nonneg CHECK ((reorder_threshold >= (0)::numeric))
);


--
-- Name: lot_allocations; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.lot_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lot_id uuid NOT NULL,
    location_node_id uuid NOT NULL,
    qty integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    grid_row smallint,
    grid_col smallint,
    CONSTRAINT ck_lot_allocations_ck_lot_allocations_cell_pairing CHECK (((grid_row IS NULL) = (grid_col IS NULL))),
    CONSTRAINT ck_lot_allocations_ck_lot_allocations_qty_nonneg CHECK (((qty)::numeric >= (0)::numeric))
);


--
-- Name: lots; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    lot_number text NOT NULL,
    supplier_id uuid,
    manufacture_date date,
    expiration_date date,
    status text DEFAULT 'available'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by_user_id uuid NOT NULL,
    updated_by_user_id uuid NOT NULL,
    unit_price_amount numeric(14,2),
    po_reference text,
    receipt_transaction_id uuid,
    parent_lot_id uuid,
    ordered_qty integer,
    receipt_transaction_line_id uuid,
    CONSTRAINT ck_lots_ck_lots_dates_ordered CHECK (((expiration_date IS NULL) OR (manufacture_date IS NULL) OR (expiration_date >= manufacture_date))),
    CONSTRAINT ck_lots_ck_lots_lot_number_not_blank CHECK ((char_length(TRIM(BOTH FROM lot_number)) > 0)),
    CONSTRAINT ck_lots_ck_lots_status CHECK ((status = ANY (ARRAY['on_order'::text, 'available'::text])))
);


--
-- Name: receipt_event_lines; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.receipt_event_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_event_id uuid NOT NULL,
    receipt_transaction_line_id uuid NOT NULL,
    qty_received integer NOT NULL,
    over_receipt_reason text,
    lot_id uuid NOT NULL,
    CONSTRAINT ck_receipt_event_lines_ck_receipt_event_lines_qty_pos CHECK ((qty_received > 0))
);


--
-- Name: receipt_events; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.receipt_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_transaction_id uuid NOT NULL,
    received_at date NOT NULL,
    received_by_user_id uuid NOT NULL,
    reauth_event_id uuid NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: receipt_transaction_lines; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.receipt_transaction_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_transaction_id uuid NOT NULL,
    line_no integer NOT NULL,
    item_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    ordered_qty integer NOT NULL,
    unit_price_amount numeric(14,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_receipt_transaction_lines_ck_receipt_transaction_lin_955d CHECK ((ordered_qty > 0))
);


--
-- Name: receipt_transactions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.receipt_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    po_reference text NOT NULL,
    notes text,
    created_by_user_id uuid NOT NULL,
    received_by_user_id uuid,
    received_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_blanket boolean DEFAULT false NOT NULL,
    valid_from date,
    valid_to date,
    deleted_at timestamp with time zone,
    CONSTRAINT ck_receipt_transactions_ck_receipt_transactions_status CHECK ((status = ANY (ARRAY['open'::text, 'partially_received'::text, 'received'::text, 'cancelled'::text]))),
    CONSTRAINT ck_receipt_transactions_ck_receipt_transactions_valid_window CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: roles; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.roles (
    code text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_movements; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    lot_id uuid,
    movement_type text NOT NULL,
    qty_delta integer NOT NULL,
    qty_abs integer NOT NULL,
    notes text,
    performed_by_user_id uuid NOT NULL,
    performed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reauth_evidence_id uuid,
    paired_movement_id uuid,
    from_location_node_id uuid,
    to_location_node_id uuid,
    CONSTRAINT ck_stock_movements_ck_movements_delta_magnitude CHECK (((abs(qty_delta))::numeric = (qty_abs)::numeric)),
    CONSTRAINT ck_stock_movements_ck_movements_locations CHECK ((((movement_type = 'receipt'::text) AND (from_location_node_id IS NULL)) OR (movement_type = ANY (ARRAY['dispense'::text, 'discard'::text])) OR ((movement_type = 'transfer_out'::text) AND (to_location_node_id IS NULL)) OR ((movement_type = 'transfer_in'::text) AND (from_location_node_id IS NULL)) OR (movement_type = 'adjustment'::text))),
    CONSTRAINT ck_stock_movements_ck_movements_no_self_pair CHECK (((paired_movement_id IS NULL) OR (paired_movement_id <> id))),
    CONSTRAINT ck_stock_movements_ck_movements_qty_abs_positive CHECK (((qty_abs)::numeric > (0)::numeric)),
    CONSTRAINT ck_stock_movements_ck_movements_type CHECK ((movement_type = ANY (ARRAY['receipt'::text, 'dispense'::text, 'adjustment'::text, 'discard'::text, 'transfer_out'::text, 'transfer_in'::text]))),
    CONSTRAINT ck_stock_movements_ck_movements_type_sign CHECK ((((movement_type = ANY (ARRAY['receipt'::text, 'transfer_in'::text])) AND ((qty_delta)::numeric > (0)::numeric)) OR ((movement_type = ANY (ARRAY['dispense'::text, 'discard'::text, 'transfer_out'::text])) AND ((qty_delta)::numeric < (0)::numeric)) OR (movement_type = 'adjustment'::text)))
);


--
-- Name: users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cognito_sub text NOT NULL,
    email public.citext NOT NULL,
    full_name text NOT NULL,
    initials character varying(8) NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_active_at timestamp with time zone,
    invited_at timestamp with time zone,
    invited_by_user_id uuid,
    accepted_invite_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT ck_users_ck_users_status_in_enum CHECK ((status = ANY (ARRAY['active'::text, 'invited'::text, 'suspended'::text])))
);


--
-- Name: v_item_stock; Type: VIEW; Schema: app; Owner: -
--

CREATE VIEW app.v_item_stock AS
 SELECT item_id,
    qty_on_hand,
    qty_available,
        CASE
            WHEN (qty_available <= 0) THEN 'out_of_stock'::text
            WHEN ((qty_available)::numeric <= reorder_threshold) THEN 'low_stock'::text
            ELSE 'available'::text
        END AS status_code,
    last_movement_at
   FROM ( SELECT i.id AS item_id,
            i.reorder_threshold,
            (COALESCE(sum(m.qty_delta), (0)::bigint))::integer AS qty_on_hand,
            (COALESCE(sum(
                CASE
                    WHEN ((l.expiration_date IS NOT NULL) AND (l.expiration_date < CURRENT_DATE)) THEN 0
                    ELSE m.qty_delta
                END), (0)::bigint))::integer AS qty_available,
            max(m.performed_at) AS last_movement_at
           FROM ((app.items i
             LEFT JOIN app.stock_movements m ON ((m.item_id = i.id)))
             LEFT JOIN app.lots l ON ((l.id = m.lot_id)))
          WHERE (i.deleted_at IS NULL)
          GROUP BY i.id, i.reorder_threshold) s;


--
-- Name: audit_events; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_user_id uuid,
    actor_kind text NOT NULL,
    event_type text NOT NULL,
    severity text NOT NULL,
    subject_table text NOT NULL,
    subject_id uuid,
    subject_label text,
    action text NOT NULL,
    before_state jsonb,
    after_state jsonb,
    diff jsonb,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    signature_id uuid,
    CONSTRAINT ck_audit_events_ck_audit_events_actor_kind CHECK ((actor_kind = ANY (ARRAY['user'::text, 'system'::text, 'integration'::text]))),
    CONSTRAINT ck_audit_events_ck_audit_events_severity CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'danger'::text]))),
    CONSTRAINT ck_audit_events_ck_audit_events_user_actor_has_id CHECK ((((actor_kind = 'user'::text) AND (actor_user_id IS NOT NULL)) OR (actor_kind = ANY (ARRAY['system'::text, 'integration'::text]))))
);


--
-- Name: reauth_consumptions; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.reauth_consumptions (
    reauth_event_id uuid NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_by_user_id uuid NOT NULL,
    target_table text NOT NULL,
    target_id uuid NOT NULL,
    CONSTRAINT ck_reauth_consumptions_ck_reauth_consumptions_target_ta_47cb CHECK ((char_length(target_table) > 0))
);


--
-- Name: reauth_events; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.reauth_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    meaning text,
    success boolean NOT NULL,
    failure_reason text,
    ip_address text,
    user_agent text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signature_image_s3_key text,
    comment text,
    CONSTRAINT ck_reauth_events_ck_reauth_events_failure_consistency CHECK ((((success = true) AND (failure_reason IS NULL)) OR ((success = false) AND (failure_reason IS NOT NULL)))),
    CONSTRAINT ck_reauth_events_ck_reauth_events_failure_reason CHECK (((failure_reason IS NULL) OR (failure_reason = ANY (ARRAY['wrong_password'::text, 'user_disabled'::text, 'rate_limited'::text, 'cognito_error'::text])))),
    CONSTRAINT ck_reauth_events_ck_reauth_events_ttl_positive CHECK ((expires_at > created_at))
);


--
-- Name: item_suppliers; Type: TABLE; Schema: meta; Owner: -
--

CREATE TABLE meta.item_suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: location_nodes; Type: TABLE; Schema: meta; Owner: -
--

CREATE TABLE meta.location_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid,
    node_type text NOT NULL,
    flat_category text,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    metadata_ jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    grid_rows smallint,
    grid_cols smallint,
    dedicated_customer_id uuid,
    dedicated_product_id uuid,
    CONSTRAINT ck_location_nodes_ck_location_nodes_dedication_exclusive CHECK ((NOT ((dedicated_customer_id IS NOT NULL) AND (dedicated_product_id IS NOT NULL)))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_dedication_quadrant_only CHECK ((((dedicated_customer_id IS NULL) AND (dedicated_product_id IS NULL)) OR (node_type = 'tank_quadrant'::text))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_flat_category CHECK (((flat_category IS NULL) OR (flat_category = ANY (ARRAY['kanban'::text, 'lab'::text, 'qc'::text, 'engineering'::text, 'materials'::text])))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_flat_category_presence CHECK (((node_type = 'flat'::text) = (flat_category IS NOT NULL))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_grid_positive CHECK ((((grid_rows IS NULL) OR (grid_rows >= 1)) AND ((grid_cols IS NULL) OR (grid_cols >= 1)))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_grid_presence CHECK (((node_type = 'box'::text) = ((grid_rows IS NOT NULL) AND (grid_cols IS NOT NULL)))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_node_type CHECK ((node_type = ANY (ARRAY['tank_quadrant'::text, 'rack'::text, 'cassette'::text, 'cryo_box_rack'::text, 'box'::text, 'flat'::text, 'cassette_rack'::text, 'sub_slot'::text]))),
    CONSTRAINT ck_location_nodes_ck_location_nodes_root_parentage CHECK (((node_type = ANY (ARRAY['tank_quadrant'::text, 'flat'::text])) = (parent_id IS NULL)))
);


--
-- Name: suppliers; Type: TABLE; Schema: meta; Owner: -
--

CREATE TABLE meta.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    contact_email text,
    phone text,
    address jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: bom_lines pk_bom_lines; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.bom_lines
    ADD CONSTRAINT pk_bom_lines PRIMARY KEY (id);


--
-- Name: customer_items pk_customer_items; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customer_items
    ADD CONSTRAINT pk_customer_items PRIMARY KEY (customer_id, item_id);


--
-- Name: customers pk_customers; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT pk_customers PRIMARY KEY (id);


--
-- Name: forecast_entries pk_forecast_entries; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.forecast_entries
    ADD CONSTRAINT pk_forecast_entries PRIMARY KEY (id);


--
-- Name: item_categories pk_item_categories; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.item_categories
    ADD CONSTRAINT pk_item_categories PRIMARY KEY (id);


--
-- Name: items pk_items; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.items
    ADD CONSTRAINT pk_items PRIMARY KEY (id);


--
-- Name: lot_allocations pk_lot_allocations; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lot_allocations
    ADD CONSTRAINT pk_lot_allocations PRIMARY KEY (id);


--
-- Name: lots pk_lots; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT pk_lots PRIMARY KEY (id);


--
-- Name: receipt_event_lines pk_receipt_event_lines; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_event_lines
    ADD CONSTRAINT pk_receipt_event_lines PRIMARY KEY (id);


--
-- Name: receipt_events pk_receipt_events; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_events
    ADD CONSTRAINT pk_receipt_events PRIMARY KEY (id);


--
-- Name: receipt_transaction_lines pk_receipt_transaction_lines; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transaction_lines
    ADD CONSTRAINT pk_receipt_transaction_lines PRIMARY KEY (id);


--
-- Name: receipt_transactions pk_receipt_transactions; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transactions
    ADD CONSTRAINT pk_receipt_transactions PRIMARY KEY (id);


--
-- Name: roles pk_roles; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.roles
    ADD CONSTRAINT pk_roles PRIMARY KEY (code);


--
-- Name: stock_movements pk_stock_movements; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT pk_stock_movements PRIMARY KEY (id);


--
-- Name: users pk_users; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT pk_users PRIMARY KEY (id);


--
-- Name: forecast_entries uq_forecast_entries_cust_prod_year_month; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.forecast_entries
    ADD CONSTRAINT uq_forecast_entries_cust_prod_year_month UNIQUE NULLS NOT DISTINCT (customer_id, product_id, forecast_year, forecast_month);


--
-- Name: receipt_event_lines uq_receipt_event_lines_event_line; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_event_lines
    ADD CONSTRAINT uq_receipt_event_lines_event_line UNIQUE (receipt_event_id, receipt_transaction_line_id);


--
-- Name: audit_events pk_audit_events; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_events
    ADD CONSTRAINT pk_audit_events PRIMARY KEY (id);


--
-- Name: reauth_consumptions pk_reauth_consumptions; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.reauth_consumptions
    ADD CONSTRAINT pk_reauth_consumptions PRIMARY KEY (reauth_event_id);


--
-- Name: reauth_events pk_reauth_events; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.reauth_events
    ADD CONSTRAINT pk_reauth_events PRIMARY KEY (id);


--
-- Name: item_suppliers pk_item_suppliers; Type: CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.item_suppliers
    ADD CONSTRAINT pk_item_suppliers PRIMARY KEY (id);


--
-- Name: location_nodes pk_location_nodes; Type: CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.location_nodes
    ADD CONSTRAINT pk_location_nodes PRIMARY KEY (id);


--
-- Name: suppliers pk_suppliers; Type: CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.suppliers
    ADD CONSTRAINT pk_suppliers PRIMARY KEY (id);


--
-- Name: item_suppliers uq_item_suppliers_item_supplier; Type: CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.item_suppliers
    ADD CONSTRAINT uq_item_suppliers_item_supplier UNIQUE (item_id, supplier_id);


--
-- Name: location_nodes uq_location_nodes_parent_code; Type: CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.location_nodes
    ADD CONSTRAINT uq_location_nodes_parent_code UNIQUE (parent_id, code);


--
-- Name: ix_bom_lines_child_item_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_bom_lines_child_item_id ON app.bom_lines USING btree (child_item_id);


--
-- Name: ix_bom_lines_parent_item_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_bom_lines_parent_item_id ON app.bom_lines USING btree (parent_item_id);


--
-- Name: ix_customer_items_item_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_customer_items_item_id ON app.customer_items USING btree (item_id);


--
-- Name: ix_customers_updated_at_desc; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_customers_updated_at_desc ON app.customers USING btree (updated_at DESC);


--
-- Name: ix_forecast_entries_customer_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_forecast_entries_customer_id ON app.forecast_entries USING btree (customer_id);


--
-- Name: ix_forecast_entries_forecast_year; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_forecast_entries_forecast_year ON app.forecast_entries USING btree (forecast_year);


--
-- Name: ix_forecast_entries_product_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_forecast_entries_product_id ON app.forecast_entries USING btree (product_id);


--
-- Name: ix_invitations_status; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_invitations_status ON app.invitations USING btree (status);


--
-- Name: ix_item_categories_updated_at_desc; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_item_categories_updated_at_desc ON app.item_categories USING btree (updated_at DESC);


--
-- Name: ix_items_category_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_items_category_id ON app.items USING btree (category_id);


--
-- Name: ix_items_description_fts; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_items_description_fts ON app.items USING gin (to_tsvector('english'::regconfig, description));


--
-- Name: ix_items_item_number_prefix; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_items_item_number_prefix ON app.items USING btree (SUBSTRING(item_number FROM 1 FOR 2));


--
-- Name: ix_items_updated_at_desc; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_items_updated_at_desc ON app.items USING btree (updated_at DESC);


--
-- Name: ix_lot_allocations_active_node; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lot_allocations_active_node ON app.lot_allocations USING btree (location_node_id) WHERE is_active;


--
-- Name: ix_lot_allocations_lot_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lot_allocations_lot_id ON app.lot_allocations USING btree (lot_id);


--
-- Name: ix_lot_allocations_node_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lot_allocations_node_id ON app.lot_allocations USING btree (location_node_id);


--
-- Name: ix_lots_expiration_date; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_expiration_date ON app.lots USING btree (expiration_date) WHERE (status = ANY (ARRAY['available'::text, 'on_order'::text]));


--
-- Name: ix_lots_item_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_item_id ON app.lots USING btree (item_id);


--
-- Name: ix_lots_parent_lot_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_parent_lot_id ON app.lots USING btree (parent_lot_id) WHERE (parent_lot_id IS NOT NULL);


--
-- Name: ix_lots_receipt_transaction_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_receipt_transaction_id ON app.lots USING btree (receipt_transaction_id) WHERE (receipt_transaction_id IS NOT NULL);


--
-- Name: ix_lots_receipt_transaction_line_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_receipt_transaction_line_id ON app.lots USING btree (receipt_transaction_line_id) WHERE (receipt_transaction_line_id IS NOT NULL);


--
-- Name: ix_lots_status; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_status ON app.lots USING btree (status);


--
-- Name: ix_lots_supplier_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_lots_supplier_id ON app.lots USING btree (supplier_id);


--
-- Name: ix_movements_from_location_node_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_from_location_node_id ON app.stock_movements USING btree (from_location_node_id) WHERE (from_location_node_id IS NOT NULL);


--
-- Name: ix_movements_item_id_performed_at; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_item_id_performed_at ON app.stock_movements USING btree (item_id, performed_at DESC);


--
-- Name: ix_movements_lot_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_lot_id ON app.stock_movements USING btree (lot_id) WHERE (lot_id IS NOT NULL);


--
-- Name: ix_movements_paired_movement_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_paired_movement_id ON app.stock_movements USING btree (paired_movement_id) WHERE (paired_movement_id IS NOT NULL);


--
-- Name: ix_movements_performed_at_desc; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_performed_at_desc ON app.stock_movements USING btree (performed_at DESC);


--
-- Name: ix_movements_reauth_evidence_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_reauth_evidence_id ON app.stock_movements USING btree (reauth_evidence_id) WHERE (reauth_evidence_id IS NOT NULL);


--
-- Name: ix_movements_to_location_node_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_to_location_node_id ON app.stock_movements USING btree (to_location_node_id) WHERE (to_location_node_id IS NOT NULL);


--
-- Name: ix_movements_type; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_movements_type ON app.stock_movements USING btree (movement_type);


--
-- Name: ix_receipt_event_lines_event_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_event_lines_event_id ON app.receipt_event_lines USING btree (receipt_event_id);


--
-- Name: ix_receipt_event_lines_line_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_event_lines_line_id ON app.receipt_event_lines USING btree (receipt_transaction_line_id);


--
-- Name: ix_receipt_event_lines_lot_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_event_lines_lot_id ON app.receipt_event_lines USING btree (lot_id);


--
-- Name: ix_receipt_events_received_at_desc; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_events_received_at_desc ON app.receipt_events USING btree (received_at DESC);


--
-- Name: ix_receipt_events_txn_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_events_txn_id ON app.receipt_events USING btree (receipt_transaction_id);


--
-- Name: ix_receipt_transaction_lines_item_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_transaction_lines_item_id ON app.receipt_transaction_lines USING btree (item_id);


--
-- Name: ix_receipt_transaction_lines_txn_id; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_transaction_lines_txn_id ON app.receipt_transaction_lines USING btree (receipt_transaction_id);


--
-- Name: ix_receipt_transactions_created_at_desc; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_transactions_created_at_desc ON app.receipt_transactions USING btree (created_at DESC);


--
-- Name: ix_receipt_transactions_status; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_receipt_transactions_status ON app.receipt_transactions USING btree (status);


--
-- Name: ix_users_role_status; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX ix_users_role_status ON app.users USING btree (role, status) WHERE (deleted_at IS NULL);


--
-- Name: uq_bom_lines_parent_child; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_bom_lines_parent_child ON app.bom_lines USING btree (parent_item_id, child_item_id) WHERE (deleted_at IS NULL);


--
-- Name: uq_customers_name; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_customers_name ON app.customers USING btree (lower(name)) WHERE (deleted_at IS NULL);


--
-- Name: uq_invitations_pending_email; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_invitations_pending_email ON app.invitations USING btree (lower((email)::text)) WHERE (status = 'pending'::app.invite_status);


--
-- Name: uq_invitations_token_hash; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_invitations_token_hash ON app.invitations USING btree (token_hash);


--
-- Name: uq_item_categories_name; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_item_categories_name ON app.item_categories USING btree (lower(name)) WHERE (deleted_at IS NULL);


--
-- Name: uq_items_item_number; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_items_item_number ON app.items USING btree (item_number) WHERE (deleted_at IS NULL);


--
-- Name: uq_lot_allocations_cell; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_lot_allocations_cell ON app.lot_allocations USING btree (location_node_id, grid_row, grid_col) WHERE (is_active AND (grid_row IS NOT NULL));


--
-- Name: uq_lots_item_lot_number; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_lots_item_lot_number ON app.lots USING btree (item_id, lot_number) WHERE (deleted_at IS NULL);


--
-- Name: uq_receipt_transactions_po_reference; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_receipt_transactions_po_reference ON app.receipt_transactions USING btree (po_reference) WHERE (deleted_at IS NULL);


--
-- Name: uq_users_cognito_sub; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_users_cognito_sub ON app.users USING btree (cognito_sub);


--
-- Name: uq_users_email; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX uq_users_email ON app.users USING btree (lower((email)::text)) WHERE (deleted_at IS NULL);


--
-- Name: ix_audit_events_actor; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_events_actor ON audit.audit_events USING btree (actor_user_id, occurred_at DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: ix_audit_events_event_type; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_events_event_type ON audit.audit_events USING btree (event_type, occurred_at DESC);


--
-- Name: ix_audit_events_occurred_at; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_events_occurred_at ON audit.audit_events USING btree (occurred_at DESC);


--
-- Name: ix_audit_events_subject; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_events_subject ON audit.audit_events USING btree (subject_table, subject_id, occurred_at DESC);


--
-- Name: ix_reauth_consumptions_consumed_at_desc; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_reauth_consumptions_consumed_at_desc ON audit.reauth_consumptions USING btree (consumed_at DESC);


--
-- Name: ix_reauth_consumptions_user_id; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_reauth_consumptions_user_id ON audit.reauth_consumptions USING btree (consumed_by_user_id);


--
-- Name: ix_reauth_events_active; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_reauth_events_active ON audit.reauth_events USING btree (id, user_id, action) WHERE (success = true);


--
-- Name: ix_reauth_events_failures; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_reauth_events_failures ON audit.reauth_events USING btree (user_id, created_at) WHERE (success = false);


--
-- Name: ix_reauth_events_user_id_created_at; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_reauth_events_user_id_created_at ON audit.reauth_events USING btree (user_id, created_at DESC);


--
-- Name: ix_item_suppliers_item_id; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_item_suppliers_item_id ON meta.item_suppliers USING btree (item_id);


--
-- Name: ix_item_suppliers_supplier_id; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_item_suppliers_supplier_id ON meta.item_suppliers USING btree (supplier_id);


--
-- Name: ix_location_nodes_active; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_location_nodes_active ON meta.location_nodes USING btree (is_active);


--
-- Name: ix_location_nodes_dedicated_customer; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_location_nodes_dedicated_customer ON meta.location_nodes USING btree (dedicated_customer_id) WHERE (dedicated_customer_id IS NOT NULL);


--
-- Name: ix_location_nodes_dedicated_product; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_location_nodes_dedicated_product ON meta.location_nodes USING btree (dedicated_product_id) WHERE (dedicated_product_id IS NOT NULL);


--
-- Name: ix_location_nodes_flat_category; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_location_nodes_flat_category ON meta.location_nodes USING btree (flat_category);


--
-- Name: ix_location_nodes_node_type; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_location_nodes_node_type ON meta.location_nodes USING btree (node_type);


--
-- Name: ix_location_nodes_parent_id; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_location_nodes_parent_id ON meta.location_nodes USING btree (parent_id);


--
-- Name: ix_suppliers_active; Type: INDEX; Schema: meta; Owner: -
--

CREATE INDEX ix_suppliers_active ON meta.suppliers USING btree (is_active);


--
-- Name: uq_suppliers_name; Type: INDEX; Schema: meta; Owner: -
--

CREATE UNIQUE INDEX uq_suppliers_name ON meta.suppliers USING btree (lower(name));


--
-- Name: bom_lines tg_bom_lines_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_bom_lines_touch_updated_at BEFORE UPDATE ON app.bom_lines FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: customers tg_customers_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_customers_touch_updated_at BEFORE UPDATE ON app.customers FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: forecast_entries tg_forecast_entries_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_forecast_entries_touch_updated_at BEFORE UPDATE ON app.forecast_entries FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: invitations tg_invitations_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_invitations_touch_updated_at BEFORE UPDATE ON app.invitations FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: item_categories tg_item_categories_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_item_categories_touch_updated_at BEFORE UPDATE ON app.item_categories FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: items tg_items_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_items_touch_updated_at BEFORE UPDATE ON app.items FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: lots tg_lots_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_lots_touch_updated_at BEFORE UPDATE ON app.lots FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: stock_movements tg_stock_movements_no_delete; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_stock_movements_no_delete BEFORE DELETE ON app.stock_movements FOR EACH ROW EXECUTE FUNCTION app.tg_movements_immutable();


--
-- Name: stock_movements tg_stock_movements_no_truncate; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_stock_movements_no_truncate BEFORE TRUNCATE ON app.stock_movements FOR EACH STATEMENT EXECUTE FUNCTION app.tg_movements_immutable();


--
-- Name: stock_movements tg_stock_movements_no_update; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_stock_movements_no_update BEFORE UPDATE ON app.stock_movements FOR EACH ROW EXECUTE FUNCTION app.tg_movements_immutable();


--
-- Name: users tg_users_touch_updated_at; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER tg_users_touch_updated_at BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: audit_events tg_audit_events_no_delete; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_audit_events_no_delete BEFORE DELETE ON audit.audit_events FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_events_immutable();


--
-- Name: audit_events tg_audit_events_no_truncate; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_audit_events_no_truncate BEFORE TRUNCATE ON audit.audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit.tg_audit_events_immutable();


--
-- Name: audit_events tg_audit_events_no_update; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_audit_events_no_update BEFORE UPDATE ON audit.audit_events FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_events_immutable();


--
-- Name: reauth_consumptions tg_reauth_consumptions_no_delete; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_reauth_consumptions_no_delete BEFORE DELETE ON audit.reauth_consumptions FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_consumptions_immutable();


--
-- Name: reauth_consumptions tg_reauth_consumptions_no_truncate; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_reauth_consumptions_no_truncate BEFORE TRUNCATE ON audit.reauth_consumptions FOR EACH STATEMENT EXECUTE FUNCTION audit.tg_reauth_consumptions_immutable();


--
-- Name: reauth_consumptions tg_reauth_consumptions_no_update; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_reauth_consumptions_no_update BEFORE UPDATE ON audit.reauth_consumptions FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_consumptions_immutable();


--
-- Name: reauth_events tg_reauth_events_no_delete; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_reauth_events_no_delete BEFORE DELETE ON audit.reauth_events FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_events_immutable();


--
-- Name: reauth_events tg_reauth_events_no_truncate; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_reauth_events_no_truncate BEFORE TRUNCATE ON audit.reauth_events FOR EACH STATEMENT EXECUTE FUNCTION audit.tg_reauth_events_immutable();


--
-- Name: reauth_events tg_reauth_events_no_update; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER tg_reauth_events_no_update BEFORE UPDATE ON audit.reauth_events FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_events_immutable();


--
-- Name: suppliers tg_suppliers_touch_updated_at; Type: TRIGGER; Schema: meta; Owner: -
--

CREATE TRIGGER tg_suppliers_touch_updated_at BEFORE UPDATE ON meta.suppliers FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();


--
-- Name: bom_lines fk_bom_lines_child_item_id_items; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.bom_lines
    ADD CONSTRAINT fk_bom_lines_child_item_id_items FOREIGN KEY (child_item_id) REFERENCES app.items(id) ON DELETE RESTRICT;


--
-- Name: bom_lines fk_bom_lines_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.bom_lines
    ADD CONSTRAINT fk_bom_lines_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: bom_lines fk_bom_lines_parent_item_id_items; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.bom_lines
    ADD CONSTRAINT fk_bom_lines_parent_item_id_items FOREIGN KEY (parent_item_id) REFERENCES app.items(id) ON DELETE RESTRICT;


--
-- Name: bom_lines fk_bom_lines_updated_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.bom_lines
    ADD CONSTRAINT fk_bom_lines_updated_by_user_id_users FOREIGN KEY (updated_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: customer_items fk_customer_items_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customer_items
    ADD CONSTRAINT fk_customer_items_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: customer_items fk_customer_items_customer_id_customers; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customer_items
    ADD CONSTRAINT fk_customer_items_customer_id_customers FOREIGN KEY (customer_id) REFERENCES app.customers(id) ON DELETE CASCADE;


--
-- Name: customer_items fk_customer_items_item_id_items; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customer_items
    ADD CONSTRAINT fk_customer_items_item_id_items FOREIGN KEY (item_id) REFERENCES app.items(id) ON DELETE CASCADE;


--
-- Name: customers fk_customers_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT fk_customers_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: customers fk_customers_updated_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.customers
    ADD CONSTRAINT fk_customers_updated_by_user_id_users FOREIGN KEY (updated_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: forecast_entries fk_forecast_entries_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.forecast_entries
    ADD CONSTRAINT fk_forecast_entries_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: forecast_entries fk_forecast_entries_customer_id_customers; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.forecast_entries
    ADD CONSTRAINT fk_forecast_entries_customer_id_customers FOREIGN KEY (customer_id) REFERENCES app.customers(id) ON DELETE CASCADE;


--
-- Name: forecast_entries fk_forecast_entries_product_id_items; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.forecast_entries
    ADD CONSTRAINT fk_forecast_entries_product_id_items FOREIGN KEY (product_id) REFERENCES app.items(id) ON DELETE CASCADE;


--
-- Name: forecast_entries fk_forecast_entries_updated_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.forecast_entries
    ADD CONSTRAINT fk_forecast_entries_updated_by_user_id_users FOREIGN KEY (updated_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: invitations fk_invitations_invited_by_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invitations
    ADD CONSTRAINT fk_invitations_invited_by_users FOREIGN KEY (invited_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: invitations fk_invitations_role_roles; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.invitations
    ADD CONSTRAINT fk_invitations_role_roles FOREIGN KEY (role) REFERENCES app.roles(code) ON DELETE RESTRICT;


--
-- Name: item_categories fk_item_categories_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.item_categories
    ADD CONSTRAINT fk_item_categories_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: item_categories fk_item_categories_updated_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.item_categories
    ADD CONSTRAINT fk_item_categories_updated_by_user_id_users FOREIGN KEY (updated_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: items fk_items_category_id_item_categories; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.items
    ADD CONSTRAINT fk_items_category_id_item_categories FOREIGN KEY (category_id) REFERENCES app.item_categories(id) ON DELETE RESTRICT;


--
-- Name: items fk_items_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.items
    ADD CONSTRAINT fk_items_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: items fk_items_updated_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.items
    ADD CONSTRAINT fk_items_updated_by_user_id_users FOREIGN KEY (updated_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: lot_allocations fk_lot_allocations_created_by_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lot_allocations
    ADD CONSTRAINT fk_lot_allocations_created_by_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: lot_allocations fk_lot_allocations_lot; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lot_allocations
    ADD CONSTRAINT fk_lot_allocations_lot FOREIGN KEY (lot_id) REFERENCES app.lots(id) ON DELETE RESTRICT;


--
-- Name: lot_allocations fk_lot_allocations_node; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lot_allocations
    ADD CONSTRAINT fk_lot_allocations_node FOREIGN KEY (location_node_id) REFERENCES meta.location_nodes(id) ON DELETE RESTRICT;


--
-- Name: lots fk_lots_created_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: lots fk_lots_item_id_items; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_item_id_items FOREIGN KEY (item_id) REFERENCES app.items(id) ON DELETE RESTRICT;


--
-- Name: lots fk_lots_parent_lot_id_lots; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_parent_lot_id_lots FOREIGN KEY (parent_lot_id) REFERENCES app.lots(id) ON DELETE SET NULL;


--
-- Name: lots fk_lots_receipt_transaction_id_receipt_transactions; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_receipt_transaction_id_receipt_transactions FOREIGN KEY (receipt_transaction_id) REFERENCES app.receipt_transactions(id) ON DELETE SET NULL;


--
-- Name: lots fk_lots_receipt_transaction_line_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_receipt_transaction_line_id FOREIGN KEY (receipt_transaction_line_id) REFERENCES app.receipt_transaction_lines(id) ON DELETE SET NULL;


--
-- Name: lots fk_lots_supplier_id_suppliers; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_supplier_id_suppliers FOREIGN KEY (supplier_id) REFERENCES meta.suppliers(id) ON DELETE RESTRICT;


--
-- Name: lots fk_lots_updated_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.lots
    ADD CONSTRAINT fk_lots_updated_by_user_id_users FOREIGN KEY (updated_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_movements_item_id_items; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_movements_item_id_items FOREIGN KEY (item_id) REFERENCES app.items(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_movements_lot_id_lots; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_movements_lot_id_lots FOREIGN KEY (lot_id) REFERENCES app.lots(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_movements_performed_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_movements_performed_by_user_id_users FOREIGN KEY (performed_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_movements_reauth_evidence_id_events; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_movements_reauth_evidence_id_events FOREIGN KEY (reauth_evidence_id) REFERENCES audit.reauth_events(id) ON DELETE RESTRICT;


--
-- Name: receipt_event_lines fk_receipt_event_lines_event_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_event_lines
    ADD CONSTRAINT fk_receipt_event_lines_event_id FOREIGN KEY (receipt_event_id) REFERENCES app.receipt_events(id) ON DELETE CASCADE;


--
-- Name: receipt_event_lines fk_receipt_event_lines_line_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_event_lines
    ADD CONSTRAINT fk_receipt_event_lines_line_id FOREIGN KEY (receipt_transaction_line_id) REFERENCES app.receipt_transaction_lines(id) ON DELETE RESTRICT;


--
-- Name: receipt_event_lines fk_receipt_event_lines_lot_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_event_lines
    ADD CONSTRAINT fk_receipt_event_lines_lot_id FOREIGN KEY (lot_id) REFERENCES app.lots(id) ON DELETE RESTRICT;


--
-- Name: receipt_events fk_receipt_events_reauth_event_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_events
    ADD CONSTRAINT fk_receipt_events_reauth_event_id FOREIGN KEY (reauth_event_id) REFERENCES audit.reauth_events(id) ON DELETE RESTRICT;


--
-- Name: receipt_events fk_receipt_events_received_by_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_events
    ADD CONSTRAINT fk_receipt_events_received_by_users FOREIGN KEY (received_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: receipt_events fk_receipt_events_txn_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_events
    ADD CONSTRAINT fk_receipt_events_txn_id FOREIGN KEY (receipt_transaction_id) REFERENCES app.receipt_transactions(id) ON DELETE RESTRICT;


--
-- Name: receipt_transaction_lines fk_receipt_transaction_lines_item_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transaction_lines
    ADD CONSTRAINT fk_receipt_transaction_lines_item_id FOREIGN KEY (item_id) REFERENCES app.items(id) ON DELETE RESTRICT;


--
-- Name: receipt_transaction_lines fk_receipt_transaction_lines_supplier_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transaction_lines
    ADD CONSTRAINT fk_receipt_transaction_lines_supplier_id FOREIGN KEY (supplier_id) REFERENCES meta.suppliers(id) ON DELETE RESTRICT;


--
-- Name: receipt_transaction_lines fk_receipt_transaction_lines_txn_id; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transaction_lines
    ADD CONSTRAINT fk_receipt_transaction_lines_txn_id FOREIGN KEY (receipt_transaction_id) REFERENCES app.receipt_transactions(id) ON DELETE CASCADE;


--
-- Name: receipt_transactions fk_receipt_transactions_created_by_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transactions
    ADD CONSTRAINT fk_receipt_transactions_created_by_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: receipt_transactions fk_receipt_transactions_received_by_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.receipt_transactions
    ADD CONSTRAINT fk_receipt_transactions_received_by_users FOREIGN KEY (received_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_stock_movements_from_location_node_id_location_nodes; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_stock_movements_from_location_node_id_location_nodes FOREIGN KEY (from_location_node_id) REFERENCES meta.location_nodes(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_stock_movements_paired_movement_id_stock_movements; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_stock_movements_paired_movement_id_stock_movements FOREIGN KEY (paired_movement_id) REFERENCES app.stock_movements(id) ON DELETE RESTRICT;


--
-- Name: stock_movements fk_stock_movements_to_location_node_id_location_nodes; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.stock_movements
    ADD CONSTRAINT fk_stock_movements_to_location_node_id_location_nodes FOREIGN KEY (to_location_node_id) REFERENCES meta.location_nodes(id) ON DELETE RESTRICT;


--
-- Name: users fk_users_invited_by_user_id_users; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT fk_users_invited_by_user_id_users FOREIGN KEY (invited_by_user_id) REFERENCES app.users(id) ON DELETE SET NULL;


--
-- Name: users fk_users_role_roles; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT fk_users_role_roles FOREIGN KEY (role) REFERENCES app.roles(code) ON DELETE RESTRICT;


--
-- Name: audit_events fk_audit_events_actor_user_id_users; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_events
    ADD CONSTRAINT fk_audit_events_actor_user_id_users FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: audit_events fk_audit_events_signature_id_reauth_events; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_events
    ADD CONSTRAINT fk_audit_events_signature_id_reauth_events FOREIGN KEY (signature_id) REFERENCES audit.reauth_events(id) ON DELETE RESTRICT;


--
-- Name: reauth_consumptions fk_reauth_consumptions_event_id_events; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.reauth_consumptions
    ADD CONSTRAINT fk_reauth_consumptions_event_id_events FOREIGN KEY (reauth_event_id) REFERENCES audit.reauth_events(id) ON DELETE RESTRICT;


--
-- Name: reauth_consumptions fk_reauth_consumptions_user_id_users; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.reauth_consumptions
    ADD CONSTRAINT fk_reauth_consumptions_user_id_users FOREIGN KEY (consumed_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: reauth_events fk_reauth_events_user_id_users; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.reauth_events
    ADD CONSTRAINT fk_reauth_events_user_id_users FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: item_suppliers fk_item_suppliers_created_by_users; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.item_suppliers
    ADD CONSTRAINT fk_item_suppliers_created_by_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: item_suppliers fk_item_suppliers_item_id_items; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.item_suppliers
    ADD CONSTRAINT fk_item_suppliers_item_id_items FOREIGN KEY (item_id) REFERENCES app.items(id) ON DELETE CASCADE;


--
-- Name: item_suppliers fk_item_suppliers_supplier_id_suppliers; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.item_suppliers
    ADD CONSTRAINT fk_item_suppliers_supplier_id_suppliers FOREIGN KEY (supplier_id) REFERENCES meta.suppliers(id) ON DELETE RESTRICT;


--
-- Name: location_nodes fk_location_nodes_created_by_users; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.location_nodes
    ADD CONSTRAINT fk_location_nodes_created_by_users FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: location_nodes fk_location_nodes_dedicated_customer_id_customers; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.location_nodes
    ADD CONSTRAINT fk_location_nodes_dedicated_customer_id_customers FOREIGN KEY (dedicated_customer_id) REFERENCES app.customers(id) ON DELETE RESTRICT;


--
-- Name: location_nodes fk_location_nodes_dedicated_product_id_items; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.location_nodes
    ADD CONSTRAINT fk_location_nodes_dedicated_product_id_items FOREIGN KEY (dedicated_product_id) REFERENCES app.items(id) ON DELETE RESTRICT;


--
-- Name: location_nodes fk_location_nodes_parent_id; Type: FK CONSTRAINT; Schema: meta; Owner: -
--

ALTER TABLE ONLY meta.location_nodes
    ADD CONSTRAINT fk_location_nodes_parent_id FOREIGN KEY (parent_id) REFERENCES meta.location_nodes(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


