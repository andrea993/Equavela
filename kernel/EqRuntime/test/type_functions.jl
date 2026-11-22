@testset "Expression type inspection" begin
    @test eq_isfunction(sin) == 1
    @test eq_isfunction(x -> x^2) == 1
    @test eq_isfunction(eq_vec(1, 2)) == 0
    @test eq_isrange(eq_range(0, 3)) == 1
    @test eq_isrange(eq_vec(0, 1, 2, 3)) == 0
    @test eq_isrange(2) == 0
    @test eq_siunitsof(0) == 1
    @test eq_siunitsof(3 + 0im) == 1
    @test eq_siunitsof(2 * eq_unit("km")) == eq_unit("m")
    @test eq_siunitsof(0 * eq_unit("cm")) == eq_unit("m")
    @test eq_siunitsof(eq_unit("N")) == eq_unit("kg") * eq_unit("m") / eq_unit("s")^2
    @test eq_siunitsof(eq_unit("deg")) == 1
    @test_throws EqError eq_siunitsof(1 + im)
    @test_throws EqError eq_siunitsof("m")
    @test_throws EqError eq_siunitsof(eq_vec(1, 2))
end
