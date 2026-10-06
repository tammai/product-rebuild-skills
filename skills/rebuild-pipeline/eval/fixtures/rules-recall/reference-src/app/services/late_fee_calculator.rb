class LateFeeCalculator
  def initialize(invoice, today: Date.current)
    @invoice = invoice
    @today = today
  end

  def fee
    periods = @invoice.days_overdue(@today) / BillingConfig::LATE_FEE_PERIOD_DAYS
    return BigDecimal("0") if periods.zero?

    raw = @invoice.outstanding * BillingConfig::LATE_FEE_RATE * periods
    [raw.round(2, half: :even), BillingConfig::LATE_FEE_CAP].min
  end
end
