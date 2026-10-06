class LineItem < ApplicationRecord
  belongs_to :invoice

  validates :description, presence: true
  validates :quantity, numericality: {
    only_integer: true,
    greater_than_or_equal_to: 1,
    less_than_or_equal_to: 10_000,
    message: "quantity out of range"
  }
  validates :unit_price, numericality: { greater_than_or_equal_to: 0 }

  before_save :reject_changes_after_issue
  before_destroy :reject_changes_after_issue
  before_save :compute_amount
  after_save :refresh_invoice_totals
  after_destroy :refresh_invoice_totals

  private

  def compute_amount
    self.amount = (quantity * unit_price).round(2, half: :even)
  end

  def reject_changes_after_issue
    return if invoice.draft?

    raise ActiveRecord::ReadOnlyRecord, "line items are locked once the invoice is issued"
  end

  def refresh_invoice_totals
    invoice.recalculate_totals!
  end
end
