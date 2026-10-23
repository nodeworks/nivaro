-- The two Directus-era tables the realtime features still write to directly (presence and chat).
-- A fresh install has neither: the boot migrations only ALTER them when they exist (200/202/203,
-- 213/214), so without these presence writes and chat sends fail on a new database. Shape copied
-- from EFP_Development (INFORMATION_SCHEMA, read-only) on 2026-10-23.
IF OBJECT_ID('dbo.user_presence') IS NULL
BEGIN
  CREATE TABLE dbo.user_presence (
    id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_id nvarchar(36) NOT NULL,
    last_seen datetimeoffset NOT NULL,
    display_name nvarchar(255) NULL,
    role_name nvarchar(100) NULL,
    divisions nvarchar(max) NULL,
    regions nvarchar(max) NULL,
    current_path nvarchar(255) NULL,
    typing_room nvarchar(255) NULL,
    is_idle bit NOT NULL DEFAULT 0,
    last_active datetime2 NULL,
    is_online bit NOT NULL DEFAULT 0,
    app nvarchar(50) NULL
  );
  CREATE UNIQUE INDEX ux_user_presence_user ON dbo.user_presence (user_id);
END;
IF OBJECT_ID('dbo.chat_messages') IS NULL
BEGIN
  CREATE TABLE dbo.chat_messages (
    id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    sender uniqueidentifier NULL,
    room nvarchar(150) NOT NULL DEFAULT 'global',
    message nvarchar(max) NOT NULL,
    date_created datetimeoffset NULL,
    read_by nvarchar(max) NULL,
    sender_name nvarchar(255) NULL,
    edited_at datetime2 NULL,
    deleted_at datetime2 NULL,
    attachments nvarchar(max) NULL,
    masquerade_admin uniqueidentifier NULL,
    parent_id int NULL,
    quote_id int NULL,
    urgent bit NULL,
    is_system bit NULL,
    no_preview bit NULL,
    client_id nvarchar(64) NULL,
    mentions nvarchar(max) NULL,
    time_refs nvarchar(max) NULL,
    ops_only bit NULL,
    via_app nvarchar(80) NULL
  );
  CREATE INDEX ix_chat_messages_room ON dbo.chat_messages (room, id);
END;
