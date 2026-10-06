class InvoicesController < ApplicationController
  before_action :load_invoice, except: :create

  def create
    customer = current_account.customers.find(params[:customer_id])
    invoice = customer.invoices.create!(status: "draft", currency: customer.currency || "USD")
    render json: invoice, status: :created
  end

  def issue
    InvoiceIssuer.new(@invoice).call
    render json: @invoice
  rescue InvoiceIssuer::NotIssuable => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  def pay
    payment = PaymentRecorder.new(@invoice).call(amount: BigDecimal(params[:amount]), source: params[:source])
    render json: payment, status: payment.status == "succeeded" ? :created : :payment_required
  rescue PaymentRecorder::Overpayment => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  def void
    return head :forbidden unless InvoicePolicy.new(current_user, @invoice).void?

    @invoice.update!(status: "void")
    render json: @invoice
  end

  private

  def load_invoice
    @invoice = current_account.invoices.find(params[:id])
  end
end
