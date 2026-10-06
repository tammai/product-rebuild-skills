class PaymentRecorder
  class Overpayment < StandardError; end

  PAYABLE = %w[issued partially_paid overdue].freeze

  def initialize(invoice, gateway: PaymentGateway.new)
    @invoice = invoice
    @gateway = gateway
  end

  def call(amount:, source:)
    raise ArgumentError, "invoice is not payable" unless PAYABLE.include?(@invoice.status)
    raise Overpayment, "overpayment" if amount > @invoice.outstanding

    payment = @invoice.payments.create!(amount: amount, source: source, status: "pending", attempts: 0)
    attempt(payment)
  end

  def attempt(payment)
    payment.increment!(:attempts)
    @gateway.charge(payment.source, payment.amount)
    payment.update!(status: "succeeded")
    settle_invoice
    payment
  rescue PaymentGateway::Declined
    payment.update!(status: "failed")
    schedule_retry(payment)
    payment
  end

  private

  def settle_invoice
    @invoice.update!(status: @invoice.outstanding.zero? ? "paid" : "partially_paid")
  end

  def schedule_retry(payment)
    if payment.attempts >= BillingConfig::PAYMENT_MAX_ATTEMPTS
      payment.update!(status: "abandoned")
      return
    end

    delay = BillingConfig::PAYMENT_RETRY_BASE_MINUTES * (2**(payment.attempts - 1))
    PaymentRetryJob.set(wait: delay.minutes).perform_later(payment.id)
  end
end
