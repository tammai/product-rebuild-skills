class InvoiceIssuer
  class NotIssuable < StandardError; end

  def initialize(invoice, renderer: PdfRenderer.new, clock: Time)
    @invoice = invoice
    @renderer = renderer
    @clock = clock
  end

  def call
    raise NotIssuable, "only draft invoices can be issued" unless @invoice.draft?
    raise NotIssuable, "customer is on credit hold" if @invoice.customer.credit_hold?
    raise NotIssuable, "invoice has no line items" if @invoice.line_items.empty?

    Invoice.transaction do
      issued_at = @clock.current
      @invoice.recalculate_totals!
      @invoice.update!(
        status: "issued",
        issued_at: issued_at,
        number: next_number(issued_at.year),
        due_date: due_date_for(issued_at.to_date, @invoice.customer.payment_terms_days)
      )
    end

    attach_pdf
    @invoice
  end

  private

  def due_date_for(issued_on, terms_days = 30)
    issued_on + (terms_days || 30)
  end

  def next_number(year)
    sequence = InvoiceSequence.next_for!(year)
    format("INV-%<year>d-%<seq>05d", year: year, seq: sequence)
  end

  def attach_pdf
    @invoice.update!(pdf: @renderer.render(@invoice), pdf_status: "ready")
  rescue PdfRenderer::Error => e
    Rails.logger.warn("pdf render failed for #{@invoice.id}: #{e.message}")
    @invoice.update!(pdf_status: "pending")
  end
end
