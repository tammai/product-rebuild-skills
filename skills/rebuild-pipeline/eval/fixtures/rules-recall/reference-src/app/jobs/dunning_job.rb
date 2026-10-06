class DunningJob < ApplicationJob
  queue_as :billing

  def perform(today = Date.current)
    Invoice.where(status: %w[issued partially_paid]).where("due_date < ?", today).find_each do |invoice|
      invoice.update!(status: "overdue")
      fee = LateFeeCalculator.new(invoice, today: today).fee
      DunningMailer.overdue(invoice, late_fee: fee).deliver_later
    end
  end
end
