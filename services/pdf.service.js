/**
 * @file services/pdf.service.js
 * @description PDF generation service using PDFKit.
 *
 * SRP: This file ONLY knows how to render a PDF given a data object.
 *      It has zero knowledge of MongoDB, Express routes, or business logic.
 *
 * Usage:
 *   import { streamEmployeeReportPdf } from './pdf.service.js';
 *   await streamEmployeeReportPdf(reportData, res); // res is the HTTP response stream
 *
 * Install dependency: npm install pdfkit
 *
 * @module services/pdf
 */

import PDFDocument from 'pdfkit';

// ─── Design Constants ─────────────────────────────────────────────────────────

const COLORS = {
   primary: '#1a1a2e',   // deep navy — header background
   accent: '#4f46e5',   // indigo — section headings
   success: '#16a34a',   // green — high completion
   warning: '#d97706',   // amber — medium completion
   danger: '#dc2626',   // red — low completion
   text: '#1f2937',   // near-black body text
   subtle: '#6b7280',   // grey metadata
   border: '#e5e7eb',   // light grey table lines
   rowAlt: '#f9fafb',   // alternating table row background
   white: '#ffffff',
};

const FONTS = {
   regular: 'Helvetica',
   bold: 'Helvetica-Bold',
   oblique: 'Helvetica-Oblique',
};

const PAGE = {
   margin: 40,
   width: 595,   // A4 points
   height: 842,
   contentWidth: 515,  // width - 2 * margin
};

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Picks a color based on completion percentage (matches frontend color scheme).
 * green > 80%, amber 50–80%, red < 50%
 *
 * @param {number} pct
 * @returns {string} Hex color string
 */
const completionColor = (pct) => {
   if (pct >= 80) return COLORS.success;
   if (pct >= 50) return COLORS.warning;
   return COLORS.danger;
};

/**
 * Formats a date string to a readable format: "15 Jan 2025"
 * @param {string|Date|null} dateVal
 */
const formatDate = (dateVal) => {
   if (!dateVal) return '—';
   return new Date(dateVal).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
   });
};

/**
 * Formats a time from a Date: "09:30 AM"
 * @param {Date|null} dateVal
 */
const formatTime = (dateVal) => {
   if (!dateVal) return '—';
   return new Date(dateVal).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: true,
   });
};

/**
 * Draws a horizontal rule across the full content width.
 * @param {PDFDocument} doc
 * @param {number} y
 * @param {string} color
 */
const drawHRule = (doc, y, color = COLORS.border) => {
   doc.moveTo(PAGE.margin, y)
      .lineTo(PAGE.margin + PAGE.contentWidth, y)
      .strokeColor(color)
      .lineWidth(0.5)
      .stroke();
};

// ─── Section Renderers ────────────────────────────────────────────────────────

/**
 * Renders the company/report header block at the top of page 1.
 * Includes: company logo placeholder, report title, generated timestamp.
 *
 * @param {PDFDocument} doc
 * @param {Object} reportData
 */
const renderHeader = (doc, reportData) => {
   const { margin, contentWidth } = PAGE;

   // ── Dark header background ──────────────────────────────────────────────────
   doc.rect(0, 0, PAGE.width, 110)
      .fill(COLORS.primary);

   // ── Logo placeholder (circle + text) ───────────────────────────────────────
   doc.circle(margin + 25, 55, 22)
      .fillAndStroke(COLORS.accent, COLORS.accent);

   doc.fillColor(COLORS.white)
      .font(FONTS.bold)
      .fontSize(14)
      .text('FT', margin + 16, 49);

   // ── Report title ────────────────────────────────────────────────────────────
   doc.fillColor(COLORS.white)
      .font(FONTS.bold)
      .fontSize(18)
      .text('Employee Performance Report', margin + 60, 32);

   doc.fillColor('#a5b4fc')     // light indigo
      .font(FONTS.regular)
      .fontSize(9)
      .text(`Generated on ${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, margin + 60, 56);

   doc.fillColor('#94a3b8')
      .fontSize(8)
      .text(`Period: ${formatDate(reportData.startDate)}  →  ${formatDate(reportData.endDate)}`, margin + 60, 70);
};

/**
 * Renders the employee info card below the header.
 *
 * @param {PDFDocument} doc
 * @param {Object} reportData
 * @returns {number} Y position after the card
 */
const renderEmployeeCard = (doc, reportData) => {
   const { margin, contentWidth } = PAGE;
   const cardY = 125;
   const cardH = 70;

   // Card background
   doc.roundedRect(margin, cardY, contentWidth, cardH, 6)
      .fill(COLORS.rowAlt);

   // Employee details
   doc.fillColor(COLORS.text)
      .font(FONTS.bold)
      .fontSize(14)
      .text(reportData.employeeName, margin + 16, cardY + 12);

   doc.fillColor(COLORS.subtle)
      .font(FONTS.regular)
      .fontSize(9)
      .text(reportData.employeeEmail, margin + 16, cardY + 32);

   // KPI summary chips (right side)
   const chipStartX = margin + contentWidth - 200;

   const chips = [
      { label: 'Days', value: reportData.totals.totalDays },
      { label: 'Hrs', value: reportData.totals.totalHours },
      { label: 'Km', value: reportData.totals.totalDistance },
      { label: 'Alerts', value: reportData.totals.totalAlerts },
   ];

   chips.forEach(({ label, value }, idx) => {
      const x = chipStartX + idx * 48;
      doc.fillColor(COLORS.accent)
         .font(FONTS.bold)
         .fontSize(13)
         .text(String(value), x, cardY + 12, { width: 42, align: 'center' });

      doc.fillColor(COLORS.subtle)
         .font(FONTS.regular)
         .fontSize(7)
         .text(label, x, cardY + 30, { width: 42, align: 'center' });
   });

   return cardY + cardH + 20;
};

/**
 * Renders the daily visit table.
 * Columns: Date | Route | Status | Visited/Total | Completion% | Hours | Distance(km)
 *
 * @param {PDFDocument} doc
 * @param {Object[]}    rows   — dailyRows from reportData
 * @param {number}      startY — Y position to start the table
 * @returns {number} Y position after the table
 */
const renderDailyTable = (doc, rows, startY) => {
   const { margin, contentWidth } = PAGE;

   // ── Table header ────────────────────────────────────────────────────────────
   const COL_WIDTHS = [70, 130, 65, 60, 65, 45, 50]; // must sum to ≤ contentWidth (515)
   const COL_HEADERS = ['Date', 'Route', 'Status', 'Centers', 'Completion', 'Hours', 'Km'];

   let y = startY;

   // Header row background
   doc.rect(margin, y, contentWidth, 22).fill(COLORS.accent);

   doc.fillColor(COLORS.white)
      .font(FONTS.bold)
      .fontSize(8);

   let x = margin;
   COL_HEADERS.forEach((header, idx) => {
      doc.text(header, x + 4, y + 7, { width: COL_WIDTHS[idx] - 4, align: 'left' });
      x += COL_WIDTHS[idx];
   });

   y += 22;

   // ── Data rows ───────────────────────────────────────────────────────────────
   rows.forEach((row, rowIdx) => {
      const rowH = 20;

      // Check for page overflow — add new page if needed
      if (y + rowH > PAGE.height - 60) {
         doc.addPage();
         y = PAGE.margin;
      }

      // Alternating row background
      if (rowIdx % 2 === 0) {
         doc.rect(margin, y, contentWidth, rowH).fill(COLORS.rowAlt);
      }

      const pct = row.completionPct;
      const cells = [
         { text: formatDate(row.date), align: 'left' },
         { text: row.routeName, align: 'left' },
         { text: row.status.replace('_', ' '), align: 'left' },
         { text: `${row.centersVisited}/${row.centersTotal}`, align: 'center' },
         { text: `${pct}%`, align: 'center', color: completionColor(pct) },
         { text: String(row.hoursWorked), align: 'center' },
         { text: String(row.distanceKm), align: 'center' },
      ];

      x = margin;
      cells.forEach((cell, idx) => {
         doc.fillColor(cell.color ?? COLORS.text)
            .font(FONTS.regular)
            .fontSize(8)
            .text(cell.text, x + 4, y + 6, {
               width: COL_WIDTHS[idx] - 8,
               align: cell.align,
               ellipsis: true,
            });
         x += COL_WIDTHS[idx];
      });

      // Bottom border for each row
      drawHRule(doc, y + rowH, COLORS.border);
      y += rowH;
   });

   return y + 10;
};

/**
 * Renders the totals summary section.
 *
 * @param {PDFDocument} doc
 * @param {Object} totals
 * @param {number} startY
 * @returns {number} Y after the section
 */
const renderTotalsSummary = (doc, totals, startY) => {
   const { margin, contentWidth } = PAGE;
   let y = startY + 10;

   doc.fillColor(COLORS.accent)
      .font(FONTS.bold)
      .fontSize(10)
      .text('Summary Totals', margin, y);

   y += 16;
   drawHRule(doc, y, COLORS.accent);
   y += 10;

   const summaryItems = [
      { label: 'Total Days Worked', value: `${totals.totalDays} days` },
      { label: 'Total Hours Worked', value: `${totals.totalHours} hrs` },
      { label: 'Total Distance', value: `${totals.totalDistance} km` },
      { label: 'Average Completion', value: `${totals.avgCompletion}%` },
      { label: 'Total Alerts Raised', value: String(totals.totalAlerts) },
   ];

   const colW = contentWidth / 3;
   summaryItems.forEach((item, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const ix = margin + col * colW;
      const iy = y + row * 38;

      doc.roundedRect(ix + 4, iy, colW - 8, 32, 4)
         .fill(COLORS.rowAlt);

      doc.fillColor(COLORS.text)
         .font(FONTS.bold)
         .fontSize(12)
         .text(item.value, ix + 8, iy + 4, { width: colW - 16, align: 'center' });

      doc.fillColor(COLORS.subtle)
         .font(FONTS.regular)
         .fontSize(7)
         .text(item.label, ix + 8, iy + 20, { width: colW - 16, align: 'center' });
   });

   return y + Math.ceil(summaryItems.length / 3) * 38 + 10;
};

/**
 * Draws a footer on every page with page number and company note.
 * Must be called after all content is written.
 *
 * @param {PDFDocument} doc
 */
const renderFooterOnAllPages = (doc) => {
   const totalPages = doc.bufferedPageRange().count;

   for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);

      const footerY = PAGE.height - 35;
      drawHRule(doc, footerY - 5, COLORS.border);

      doc.fillColor(COLORS.subtle)
         .font(FONTS.regular)
         .fontSize(7)
         .text(
            'This is a system-generated report. For queries contact your manager.',
            PAGE.margin,
            footerY + 2,
            { width: PAGE.contentWidth - 80, align: 'left' },
         );

      doc.fillColor(COLORS.subtle)
         .font(FONTS.regular)
         .fontSize(7)
         .text(
            `Page ${i + 1} of ${totalPages}`,
            PAGE.margin,
            footerY + 2,
            { width: PAGE.contentWidth, align: 'right' },
         );
   }
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a formatted employee performance PDF and streams it directly
 * into the provided writable stream (typically an Express `res` object).
 *
 * @param {Object}   reportData  — Output of reportService.buildEmployeePdfReportData()
 * @param {import('stream').Writable} outputStream — HTTP response or file write stream
 * @returns {Promise<void>}
 */
export const streamEmployeeReportPdf = (reportData, outputStream) => {
   return new Promise((resolve, reject) => {
      // bufferPages: true — lets us go back and add footer page numbers after all content
      const doc = new PDFDocument({
         size: 'A4',
         margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
         bufferPages: true,
         info: {
            Title: `Performance Report — ${reportData.employeeName}`,
            Author: 'FieldTrack System',
            Subject: `${reportData.startDate} to ${reportData.endDate}`,
            Creator: 'FieldTrack v1.0',
         },
      });

      // Pipe the PDF into the output stream (HTTP response)
      doc.pipe(outputStream);

      doc.on('error', reject);
      outputStream.on('error', reject);

      // ── Render all sections ──────────────────────────────────────────────────
      renderHeader(doc, reportData);

      let cursorY = renderEmployeeCard(doc, reportData);

      // Section title
      doc.fillColor(COLORS.accent)
         .font(FONTS.bold)
         .fontSize(10)
         .text('Daily Activity Log', PAGE.margin, cursorY);

      cursorY += 16;

      if (reportData.dailyRows.length === 0) {
         doc.fillColor(COLORS.subtle)
            .font(FONTS.oblique)
            .fontSize(9)
            .text('No assignments found for the selected date range.', PAGE.margin, cursorY);
         cursorY += 20;
      } else {
         cursorY = renderDailyTable(doc, reportData.dailyRows, cursorY);
         cursorY = renderTotalsSummary(doc, reportData.totals, cursorY);
      }

      // ── Footer on all pages ──────────────────────────────────────────────────
      renderFooterOnAllPages(doc);

      // Finalise the PDF — this triggers the 'end' event on the pipe
      doc.end();

      // Resolve when the output stream finishes
      outputStream.on('finish', resolve);
   });
};